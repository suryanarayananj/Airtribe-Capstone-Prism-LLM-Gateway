const SESSION_KEY = 'prism_chat_session';

export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) {
      return null;
    }
    const session = JSON.parse(raw);
    if (!session?.token || String(session.token).startsWith('demo:')) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

async function chatFetch(path, token, options = {}) {
  const headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${token}`,
  };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, { ...options, headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.error?.message || `Request failed (${res.status})`);
  }
  return json;
}

export async function loginChatUser(username, password) {
  const res = await fetch('/app/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json?.error?.message || `Login failed (${res.status})`);
  }
  saveSession(json);
  return json;
}

/** Refresh signed-in user (models/team) from the server. */
export async function fetchChatUser(token) {
  return chatFetch('/app/me', token);
}

export function listConversations(token) {
  return chatFetch('/app/conversations', token);
}

export function createConversation(token, title) {
  return chatFetch('/app/conversations', token, {
    method: 'POST',
    body: JSON.stringify({ title: title || 'New chat' }),
  });
}

export function getConversation(token, id) {
  return chatFetch(`/app/conversations/${id}`, token);
}

export function deleteConversation(token, id) {
  return chatFetch(`/app/conversations/${id}`, token, { method: 'DELETE' });
}

/**
 * Stream assistant reply for the current conversation messages.
 * @param {string} token
 * @param {object[]} messages
 * @param {string} model
 * @param {number | null} conversationId
 * @param {(delta: string) => void} onDelta
 * @param {boolean} [verify]
 * @returns {Promise<{ provider: string | null, conversationId: number | null, verified: boolean }>}
 */
export async function streamChat(token, messages, model, conversationId, onDelta, verify = false) {
  const res = await fetch('/app/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      messages,
      model,
      verify: Boolean(verify),
      conversation_id: conversationId || undefined,
    }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(
      errBody?.error?.message || `Chat failed (${res.status})`,
    );
  }

  const provider = res.headers.get('x-prism-provider');
  const headerConv = res.headers.get('x-prism-conversation-id');
  const resolvedId = headerConv ? Number(headerConv) : conversationId;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';

    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        continue;
      }
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') {
        continue;
      }
      try {
        const chunk = JSON.parse(data);
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (delta) {
          onDelta(delta);
        }
        if (chunk?.error?.message) {
          throw new Error(chunk.error.message);
        }
      } catch (err) {
        if (err instanceof SyntaxError) {
          continue;
        }
        throw err;
      }
    }
  }

  return {
    provider,
    verified: res.headers.get('x-prism-verified') === 'true',
    conversationId: Number.isInteger(resolvedId) ? resolvedId : null,
  };
}
