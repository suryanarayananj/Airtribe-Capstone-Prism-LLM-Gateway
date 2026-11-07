import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  clearSession,
  deleteConversation,
  fetchChatUser,
  getConversation,
  listConversations,
  loadSession,
  loginChatUser,
  saveSession,
  streamChat,
} from './chatApi.js';
import { estimateRequestCost } from './tokenEstimate.js';

const MODEL_LABELS = {
  auto: 'auto',
  fast: 'fast',
  smart: 'smart',
};

function formatTokenCount(value) {
  return Number(value || 0).toLocaleString();
}

function formatChatStamp(value) {
  const date =
    value instanceof Date
      ? value
      : new Date(
          typeof value === 'string' && value.includes(' ') && !value.includes('T')
            ? value.replace(' ', 'T')
            : value,
        );
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startThat = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDiff = Math.round((startToday - startThat) / 86_400_000);
  const time = date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  if (dayDiff === 0) {
    return `Today ${time}`;
  }
  if (dayDiff === 1) {
    return `Yesterday ${time}`;
  }
  const day = date.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return `${day} ${time}`;
}

const TOKEN_WARNING_STEPS = [
  { at: 99, note: 'The limit is about to end.' },
  { at: 98, note: 'The limit is about to end.' },
  { at: 96, note: 'The limit is very close.' },
  { at: 95, note: 'The limit is very close.' },
  { at: 90, note: 'You are close to this month’s token limit.' },
  { at: 80, note: 'You are getting close to this month’s token limit.' },
  { at: 70, note: 'You have used most of this month’s token limit.' },
];

function crossedTokenWarning(beforeUser, afterUser) {
  if (afterUser?.token_cap == null || tokenLimitReached(afterUser)) {
    return null;
  }
  const before = Number(beforeUser?.token_percent || 0);
  const after = Number(afterUser.token_percent || 0);
  const step = TOKEN_WARNING_STEPS.find((item) => before < item.at && after >= item.at);
  if (!step) {
    return null;
  }
  return `Warning: ${step.at}% of your token limit is used. ${step.note}`;
}

function tokenLimitReached(user) {
  if (user?.token_cap == null) {
    return false;
  }
  const cap = Number(user.token_cap);
  const used = Number(user.tokens_used || 0);
  if (!Number.isFinite(cap)) {
    return false;
  }
  return cap <= 0 || used >= cap;
}

function TokenUsage({ user }) {
  const cap = user?.token_cap;
  const used = Number(user?.tokens_used || 0);
  if (cap == null) {
    return (
      <div className="account-usage">
        <div className="account-usage-label">
          <span>Token limit</span>
          <span>No limit</span>
        </div>
        <p className="account-usage-detail">This account has no monthly token cap.</p>
      </div>
    );
  }
  const percent = Math.max(0, Math.min(100, Number(user?.token_percent || 0)));
  const fillClass =
    percent >= 100
      ? 'account-usage-fill full'
      : percent >= 80
        ? 'account-usage-fill high'
        : 'account-usage-fill';
  return (
    <div className="account-usage">
      <div className="account-usage-label">
        <span>Token limit</span>
        <span>{percent >= 100 ? 'Limit reached' : `${Math.round(percent)}%`}</span>
      </div>
      <div
        className="account-usage-track"
        role="meter"
        aria-label="Token limit used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <div className={fillClass} style={{ width: `${percent}%` }} />
      </div>
      <p className="account-usage-detail">
        {formatTokenCount(used)} / {formatTokenCount(cap)} tokens this month
      </p>
    </div>
  );
}

export function ChatPage() {
  const [session, setSession] = useState(() => loadSession());
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [models, setModels] = useState(() => loadSession()?.user?.models || []);
  const [model, setModel] = useState(
    () => loadSession()?.user?.models?.[0] || '',
  );
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const [verifyOn, setVerifyOn] = useState(false);
  const [pricing, setPricing] = useState(null);
  const bottomRef = useRef(null);
  const accountRef = useRef(null);
  const modelOptions = models.length ? models : [];
  const selectedModel = modelOptions.includes(model)
    ? model
    : modelOptions[0] || '';
  const hasThread = messages.length > 0;
  const verifyModels = session?.user?.verify_models || [];
  const canVerify = verifyModels.some(
    (model) => model !== selectedModel && model !== 'auto',
  );
  const costEstimate = estimateRequestCost({
    draft,
    messages,
    model: selectedModel,
    pricing,
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  useEffect(() => {
    if (!session?.token) {
      return;
    }
    refreshConversations(session.token).catch((err) => setError(err.message));
    fetchChatUser(session.token)
      .then((data) => applyProfile(data, session))
      .catch((err) => {
        if (/sign in/i.test(err.message)) {
          handleLogout();
          return;
        }
        setError(err.message);
      });
  }, [session?.token]);

  useEffect(() => {
    if (!accountOpen) {
      return undefined;
    }
    function onPointerDown(event) {
      if (!accountRef.current?.contains(event.target)) {
        setAccountOpen(false);
      }
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        setAccountOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [accountOpen]);

  function applyProfile(data, baseSession = session) {
    const nextUser = data.user;
    const nextModels = nextUser?.models || [];
    setModels(nextModels);
    setModel((current) =>
      nextModels.includes(current) ? current : nextModels[0] || '',
    );
    if (data.pricing) {
      setPricing(data.pricing);
    }
    const nextSession = { ...(baseSession || {}), user: nextUser };
    saveSession(nextSession);
    setSession(nextSession);
  }

  useEffect(() => {
    if (!accountOpen || !session?.token) {
      return undefined;
    }
    let cancelled = false;
    fetchChatUser(session.token)
      .then((data) => {
        if (!cancelled) {
          applyProfile(data);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [accountOpen]);

  async function refreshConversations(token) {
    const data = await listConversations(token);
    setConversations(data.conversations || []);
  }

  async function handleLogin(event) {
    event.preventDefault();
    setError('');
    try {
      const next = await loginChatUser(username, password);
      setSession(next);
      setModels(next.user?.models || []);
      setModel(next.user?.models?.[0] || '');
      if (next.pricing) {
        setPricing(next.pricing);
      }
      setMessages([]);
      setActiveId(null);
      setPassword('');
      await refreshConversations(next.token);
    } catch (err) {
      setError(err.message);
    }
  }

  function handleLogout() {
    clearSession();
    setAccountOpen(false);
    setSession(null);
    setModels([]);
    setModel('');
    setMessages([]);
    setConversations([]);
    setActiveId(null);
    setDraft('');
    setPricing(null);
  }

  function handleNewChat() {
    if (busy) {
      return;
    }
    setError('');
    setActiveId(null);
    setMessages([]);
    setDraft('');
  }

  async function handleOpenConversation(id) {
    if (!session?.token || busy || id === activeId) {
      return;
    }
    setError('');
    try {
      const conversation = await getConversation(session.token, id);
      setActiveId(conversation.id);
      setMessages(
        (conversation.messages || []).map((m) => ({
          role: m.role,
          content: m.content,
          createdAt: m.created_at || null,
          verified: Boolean(m.verified),
        })),
      );
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDeleteConversation(event, id) {
    event.stopPropagation();
    if (!session?.token || busy) {
      return;
    }
    setError('');
    try {
      await deleteConversation(session.token, id);
      const nextList = conversations.filter((c) => c.id !== id);
      setConversations(nextList);
      if (activeId === id) {
        setActiveId(null);
        setMessages([]);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleSend(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !session?.token || busy || !selectedModel || tokenLimitReached(session.user)) {
      return;
    }

    const beforeUser = session.user;
    const sentAt = new Date().toISOString();
    const nextMessages = [
      ...messages,
      { role: 'user', content: text, createdAt: sentAt },
    ];
    setMessages(nextMessages);
    setDraft('');
    setBusy(true);
    setError('');

    let assistant = '';
    setMessages([
      ...nextMessages,
      { role: 'assistant', content: '', createdAt: sentAt },
    ]);

    try {
      const result = await streamChat(
        session.token,
        nextMessages,
        selectedModel,
        activeId,
        (delta) => {
          assistant += delta;
          setMessages([
            ...nextMessages,
            { role: 'assistant', content: assistant, createdAt: sentAt },
          ]);
        },
        verifyOn && canVerify,
      );
      if (result.conversationId) {
        setActiveId(result.conversationId);
      }
      await refreshConversations(session.token);
      const profile = await fetchChatUser(session.token).catch(() => null);
      const limitNote = profile?.user
        ? crossedTokenWarning(beforeUser, profile.user)
        : null;
      if (profile?.user) {
        applyProfile(profile);
      }
      if (limitNote || result.verified) {
        setMessages([
          ...nextMessages,
          {
            role: 'assistant',
            content: assistant,
            createdAt: sentAt,
            limitNote,
            verified: Boolean(result.verified),
          },
        ]);
      }
    } catch (err) {
      setError(err.message);
      setMessages(nextMessages);
    } finally {
      setBusy(false);
    }
  }

  function renderComposer(centered = false) {
    if (tokenLimitReached(session?.user)) {
      return (
        <div
          className={centered ? 'limit-ended limit-ended-centered' : 'limit-ended'}
          role="status"
        >
          <strong>Token limit reached</strong>
          <span>
            This month&apos;s token limit is used up. New messages stay paused until an admin raises the cap.
          </span>
        </div>
      );
    }
    return (
      <div
        className={
          centered ? 'composer-block composer-block-centered' : 'composer-block'
        }
      >
        <form className="composer" onSubmit={handleSend}>
          <input
            type="text"
            className="composer-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              busy
                ? verifyOn && canVerify
                  ? 'Verifying…'
                  : 'Streaming…'
                : 'Message Prism…'
            }
            disabled={busy}
            autoComplete="off"
          />
          {canVerify ? (
            <button
              type="button"
              className={verifyOn ? 'verify-toggle on' : 'verify-toggle'}
              onClick={() => setVerifyOn((on) => !on)}
              disabled={busy}
              aria-pressed={verifyOn}
            >
              Verify
            </button>
          ) : null}
          <label className="composer-model">
            <span className="sr-only">Model</span>
            <select
              value={selectedModel}
              onChange={(e) => setModel(e.target.value)}
              disabled={busy || !modelOptions.length}
            >
              {modelOptions.map((id) => (
                <option key={id} value={id}>
                  {MODEL_LABELS[id] || id}
                </option>
              ))}
            </select>
          </label>
        </form>
        {costEstimate ? (
          <p className="cost-estimate" aria-live="polite">
            Estimated token consumption:{' '}
            {costEstimate.totalTokens.toLocaleString()}
          </p>
        ) : null}
      </div>
    );
  }

  if (!session) {
    return (
      <div className="login-screen">
        <div className="login-backdrop" aria-hidden="true" />
        <div className="login-stack">
          <div className="login-brand">
            <img
              className="login-logo"
              src="/brand/logo.png?v=4"
              alt=""
              width="80"
              height="80"
            />
            <div className="login-brand-text">
              <span className="brand-name">Prism</span>
              <span className="brand-tag">Chat</span>
            </div>
          </div>
          <section className="login-card">
            <h1 className="login-title">Sign in</h1>
            {error ? <p className="error login-error">{error}</p> : null}
            <form className="login-form" onSubmit={handleLogin}>
              <label className="login-field">
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder=" "
                  autoComplete="username"
                  required
                />
                <span className="login-float-label">Username</span>
              </label>
              <label className="login-field">
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder=" "
                  autoComplete="current-password"
                  required
                />
                <span className="login-float-label">Password</span>
              </label>
              <button type="submit" className="login-submit">
                Continue
              </button>
            </form>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-layout">
      <aside className="chat-side">
        <div className="brand">
          <img
            className="brand-mark"
            src="/brand/logo.png?v=4"
            alt=""
            width="28"
            height="28"
          />
          <span className="brand-text">
            <span className="brand-name">Prism</span>
            <span className="brand-tag">Chat</span>
          </span>
        </div>
        <button
          type="button"
          className="new-chat-btn"
          onClick={handleNewChat}
          disabled={busy}
        >
          New chat
        </button>
        <div className="chat-history" aria-label="Chat history">
          <div className="history-label">Recent</div>
          {conversations.length === 0 ? (
            <p className="history-empty">No chats yet</p>
          ) : (
            conversations.map((item) => (
              <div
                key={item.id}
                className={
                  item.id === activeId ? 'history-item active' : 'history-item'
                }
              >
                <button
                  type="button"
                  className="history-open"
                  onClick={() => handleOpenConversation(item.id)}
                  disabled={busy}
                >
                  {item.title || 'New chat'}
                </button>
                <button
                  type="button"
                  className="history-delete"
                  title="Delete chat"
                  aria-label="Delete chat"
                  onClick={(event) => handleDeleteConversation(event, item.id)}
                  disabled={busy}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
        <div className="chat-side-footer" ref={accountRef}>
          {accountOpen ? (
            <div className="account-menu" role="menu">
              <div className="account-menu-meta">
                <strong>{session.user.name}</strong>
                <span>{session.user.username || session.user.team}</span>
              </div>
              <TokenUsage user={session.user} />
              <button
                type="button"
                className="account-menu-item"
                role="menuitem"
                onClick={handleLogout}
              >
                Sign out
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className={accountOpen ? 'account-trigger active' : 'account-trigger'}
            onClick={() => setAccountOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={accountOpen}
          >
            <span className="account" aria-hidden="true">
              {(session.user.name || 'U').slice(0, 1).toUpperCase()}
            </span>
            <span className="account-meta">
              <strong>{session.user.name}</strong>
              <span>Team: {session.user.team}</span>
            </span>
          </button>
        </div>
      </aside>

      <main className={hasThread ? 'chat-main' : 'chat-main chat-main-empty'}>
        {error ? <p className="error chat-error">{error}</p> : null}

        {hasThread ? (
          <>
          <div className="chat-thread" aria-live="polite">
            <div className="chat-thread-inner">
              {messages[0]?.createdAt || messages.length ? (
                <div className="chat-stamp">
                  {formatChatStamp(
                    messages[0]?.createdAt || new Date().toISOString(),
                  )}
                </div>
              ) : null}
              {messages.map((msg, index) => (
                <div
                  key={`${msg.role}-${index}`}
                  className={`bubble ${msg.role === 'user' ? 'user' : 'assistant'}`}
                >
                  {msg.role === 'assistant' ? (
                    <>
                      {msg.content ? (
                        <div className="md">
                          <ReactMarkdown>{msg.content}</ReactMarkdown>
                        </div>
                      ) : busy ? (
                        verifyOn && canVerify ? 'Verifying…' : '…'
                      ) : (
                        ''
                      )}
                      {msg.verified ? (
                        <p className="verified-mark">✓ Multi-model verified</p>
                      ) : null}
                      {msg.limitNote ? <p className="token-note">{msg.limitNote}</p> : null}
                    </>
                  ) : (
                    msg.content || (busy ? '…' : '')
                  )}
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          </div>
          <div className="composer-dock">{renderComposer(false)}</div>
          </>
        ) : (
          <div className="empty-stage">
            <h1 className="empty-title">What can I help with?</h1>
            {renderComposer(true)}
          </div>
        )}
      </main>
    </div>
  );
}
