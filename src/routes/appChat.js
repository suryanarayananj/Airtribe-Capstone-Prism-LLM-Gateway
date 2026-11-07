import { config } from '../config.js';
import { currentYearMonth } from '../budget.js';
import { CHAT_PROXY_HEADER, CHAT_PROXY_VALUE } from '../auth.js';
import {
  accessModeAllowsChat,
  appendConversationMessages,
  createChatSession,
  createConversation,
  deleteConversation,
  findActiveKeyForUser,
  findUserByUsername,
  getConversation,
  getMonthlyUsage,
  listConversations,
  renameConversation,
  resolveChatSession,
} from '../db.js';
import { PrismError } from '../errors.js';
import { verifyPassword } from '../passwords.js';
import { extractAssistantFromSse } from '../providers/adapter.js';

function chatProxyHeaders(virtualKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${virtualKey}`,
    [CHAT_PROXY_HEADER]: CHAT_PROXY_VALUE,
  };
}

function modelsFromAllowlist(raw) {
  let allow = [];
  try {
    allow = JSON.parse(raw || '[]');
  } catch {
    allow = [];
  }
  if (!Array.isArray(allow)) {
    allow = [];
  }
  const preferred = ['auto', 'fast', 'smart'];
  return [...allow].sort((a, b) => {
    const ia = preferred.indexOf(a);
    const ib = preferred.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

function finiteCap(value) {
  if (value == null || value === '') {
    return null;
  }
  const cap = Number(value);
  return Number.isFinite(cap) ? cap : null;
}

/** Tightest monthly token cap that budget enforcement actually applies. */
function tokenUsageForSession(session) {
  const caps = [finiteCap(session.user_token_cap), finiteCap(session.key_token_cap)].filter(
    (cap) => cap != null,
  );
  const tokenCap = caps.length ? Math.min(...caps) : null;
  const usage = session.virtual_key
    ? getMonthlyUsage(session.virtual_key, currentYearMonth())
    : null;
  const tokensUsed =
    Number(usage?.prompt_tokens || 0) + Number(usage?.completion_tokens || 0);
  let tokenPercent = null;
  if (tokenCap != null) {
    tokenPercent = tokenCap <= 0 ? 100 : Math.min(100, (tokensUsed / tokenCap) * 100);
  }
  return {
    tokens_used: tokensUsed,
    token_cap: tokenCap,
    token_percent: tokenPercent,
  };
}

function listFromJson(raw) {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item));
  }
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function publicUser(session) {
  const allowed = modelsFromAllowlist(session.model_allowlist);
  const verifyModels = listFromJson(session.verify_models).filter((model) =>
    allowed.includes(model),
  );
  return {
    id: session.user_id,
    name: session.name,
    username: session.username,
    team: session.team,
    access_mode: session.access_mode || 'both',
    models: allowed,
    verify_models: verifyModels,
    ...tokenUsageForSession(session),
  };
}

/** Pricing snapshot for the chat UI pre-send cost estimate (loaded once, computed client-side). */
function estimatePricingPayload() {
  const aliases = {};
  for (const [name, cfg] of Object.entries(config.modelAliases || {})) {
    if (name === 'auto') {
      aliases.auto = config.modelAliases.fast?.primary || 'alpha-small';
      continue;
    }
    if (cfg?.primary) {
      aliases[name] = cfg.primary;
    }
  }
  const models = {};
  for (const [id, prices] of Object.entries(config.modelPricing || {})) {
    if (id.startsWith('_') || !prices || typeof prices !== 'object') {
      continue;
    }
    if (prices.input_per_1m == null || prices.output_per_1m == null) {
      continue;
    }
    models[id] = {
      input_per_1m: Number(prices.input_per_1m),
      output_per_1m: Number(prices.output_per_1m),
    };
  }
  return {
    assumed_output_tokens: 200,
    aliases,
    models,
  };
}

function lastUserText(messages) {
  const last = [...messages]
    .reverse()
    .find((message) => message?.role === 'user' && String(message.content || '').trim());
  return last ? String(last.content) : '';
}

function hasVerificationRoom(session) {
  const caps = [finiteCap(session.user_token_cap), finiteCap(session.key_token_cap)].filter(
    (cap) => cap != null && cap > 0,
  );
  if (!caps.length || !session.virtual_key) {
    return true;
  }
  const cap = Math.min(...caps);
  const usage = getMonthlyUsage(session.virtual_key, currentYearMonth());
  const used =
    Number(usage?.prompt_tokens || 0) + Number(usage?.completion_tokens || 0);
  return cap - used > Math.max(200, Math.floor(cap * 0.1));
}

function parseVerdict(text) {
  const raw = String(text || '');
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      return {
        agree: parsed.agree !== false,
        issue: String(parsed.issue || '').trim(),
      };
    } catch {
      /* fall through */
    }
  }
  const lower = raw.toLowerCase();
  if (lower.includes('disagree') || lower.includes('"agree":false') || lower.includes('"agree": false')) {
    return { agree: false, issue: raw.slice(0, 240) };
  }
  return { agree: true, issue: '' };
}

async function completeOnce(base, virtualKey, model, messages) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: chatProxyHeaders(virtualKey),
    body: JSON.stringify({ model, messages, stream: false }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(json?.error?.message || `Chat upstream HTTP ${res.status}`);
    error.statusCode = res.status;
    error.body = json;
    throw error;
  }
  return {
    content: String(json?.choices?.[0]?.message?.content || ''),
    provider: res.headers.get('x-prism-provider'),
  };
}

function writeVerifiedSse(raw, text) {
  const payload = JSON.stringify({
    choices: [{ index: 0, delta: { content: text } }],
  });
  raw.write(`data: ${payload}\n\n`);
  raw.write('data: [DONE]\n\n');
}

/**
 * Draft, check with the admin models, then one edit if a checker disagrees.
 * A failed checker returns the draft with verified false.
 */
async function verifyAcrossModels({ base, virtualKey, writer, checkers, messages }) {
  const question = lastUserText(messages);
  const draft = await completeOnce(base, virtualKey, writer, messages);
  const issues = [];
  for (const checker of checkers) {
    let verdictText = '';
    try {
      const checked = await completeOnce(base, virtualKey, checker, [
        {
          role: 'user',
          content:
            'Check this draft. Reply with JSON only: {"agree":true} or {"agree":false,"issue":"what is wrong"}.\n\n' +
            `Question:\n${question}\n\nDraft:\n${draft.content}`,
        },
      ]);
      verdictText = checked.content;
    } catch {
      return { content: draft.content, provider: draft.provider, verified: false };
    }
    const verdict = parseVerdict(verdictText);
    if (!verdict.agree) {
      issues.push(verdict.issue || `${checker} disagreed`);
    }
  }
  if (!issues.length) {
    return { content: draft.content, provider: draft.provider, verified: true };
  }
  try {
    const revised = await completeOnce(base, virtualKey, writer, [
      ...messages,
      { role: 'assistant', content: draft.content },
      {
        role: 'user',
        content:
          `Revise the answer using these checks:\n${issues.join('\n')}\nReturn only the revised answer.`,
      },
    ]);
    return {
      content: revised.content || draft.content,
      provider: revised.provider || draft.provider,
      verified: true,
    };
  } catch {
    return { content: draft.content, provider: draft.provider, verified: false };
  }
}

function requireChatSession(request) {
  const header = request.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const session = match ? resolveChatSession(match[1].trim()) : null;
  if (!session || session.user_status !== 'active') {
    throw new PrismError({
      statusCode: 401,
      type: 'authentication_error',
      message: 'Sign in to chat first',
    });
  }
  if (!accessModeAllowsChat(session.access_mode)) {
    throw new PrismError({
      statusCode: 403,
      type: 'permission_error',
      message: 'This account is API-only and cannot use chat',
    });
  }
  return session;
}

/**
 * Username/password chat login plus conversation history (chat users only).
 * @param {import('fastify').FastifyInstance} app
 */
export async function registerAppChatRoutes(app) {
  app.get('/app/me', async (request) => {
    const session = requireChatSession(request);
    return {
      user: publicUser(session),
      pricing: estimatePricingPayload(),
    };
  });

  app.post('/app/login', async (request) => {
    const username = String(request.body?.username || '').trim().toLowerCase();
    const password = String(request.body?.password || '');
    const user = username ? findUserByUsername(username) : null;
    if (!user || user.status !== 'active' || !verifyPassword(password, user.password_hash)) {
      throw new PrismError({
        statusCode: 401,
        type: 'authentication_error',
        message: 'Unknown username or password',
      });
    }
    if (!accessModeAllowsChat(user.access_mode)) {
      throw new PrismError({
        statusCode: 403,
        type: 'permission_error',
        message:
          'This account is API-only. Use the virtual key on /v1, or ask an admin for Chat or Both access.',
      });
    }

    const key = findActiveKeyForUser(user.id);
    if (!key?.virtual_key) {
      throw new PrismError({
        statusCode: 403,
        type: 'permission_error',
        message: 'This user has no virtual key yet. Ask an admin to create one.',
      });
    }
    const token = createChatSession(user.id);
    const session = resolveChatSession(token);

    return {
      token,
      user: publicUser(session),
      pricing: estimatePricingPayload(),
    };
  });

  app.get('/app/conversations', async (request) => {
    const session = requireChatSession(request);
    return { conversations: listConversations(session.user_id) };
  });

  app.post('/app/conversations', async (request) => {
    const session = requireChatSession(request);
    const title =
      typeof request.body?.title === 'string' ? request.body.title : 'New chat';
    return createConversation(session.user_id, title);
  });

  app.get('/app/conversations/:id', async (request) => {
    const session = requireChatSession(request);
    const conversation = getConversation(Number(request.params.id), session.user_id);
    if (!conversation) {
      throw new PrismError({
        statusCode: 404,
        type: 'invalid_request_error',
        message: 'Conversation not found',
      });
    }
    return conversation;
  });

  app.patch('/app/conversations/:id', async (request) => {
    const session = requireChatSession(request);
    try {
      const conversation = renameConversation(
        Number(request.params.id),
        session.user_id,
        request.body?.title,
      );
      if (!conversation) {
        throw new PrismError({
          statusCode: 404,
          type: 'invalid_request_error',
          message: 'Conversation not found',
        });
      }
      return conversation;
    } catch (err) {
      if (err instanceof PrismError) {
        throw err;
      }
      throw new PrismError({
        statusCode: 400,
        type: 'invalid_request_error',
        message: err.message || 'Could not rename conversation',
      });
    }
  });

  app.delete('/app/conversations/:id', async (request) => {
    const session = requireChatSession(request);
    const ok = deleteConversation(Number(request.params.id), session.user_id);
    if (!ok) {
      throw new PrismError({
        statusCode: 404,
        type: 'invalid_request_error',
        message: 'Conversation not found',
      });
    }
    return { deleted: true };
  });

  app.post('/app/chat', async (request, reply) => {
    const session = requireChatSession(request);
    if (!session.virtual_key) {
      throw new PrismError({
        statusCode: 403,
        type: 'permission_error',
        message: 'This user has no virtual key yet',
      });
    }

    const messages = request.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new PrismError({
        statusCode: 400,
        type: 'invalid_request_error',
        message: 'messages must be a non-empty array',
      });
    }

    const requestedModel =
      typeof request.body?.model === 'string' && request.body.model.trim()
        ? request.body.model.trim()
        : 'auto';
    const allowed = modelsFromAllowlist(session.model_allowlist);
    if (!allowed.includes(requestedModel)) {
      throw new PrismError({
        statusCode: 403,
        type: 'permission_error',
        message: `Model '${requestedModel}' is not allowed for this user`,
      });
    }

    let conversationId = Number(request.body?.conversation_id);
    let conversation = Number.isInteger(conversationId) && conversationId > 0
      ? getConversation(conversationId, session.user_id)
      : null;
    if (!conversation) {
      conversation = createConversation(session.user_id);
      conversationId = conversation.id;
    }

    const base = `http://127.0.0.1:${config.port}`;
    const wantVerify = request.body?.verify === true;
    if (wantVerify) {
      const checkers = listFromJson(session.verify_models).filter(
        (model) =>
          allowed.includes(model) &&
          model !== requestedModel &&
          model !== 'auto',
      );
      if (!checkers.length) {
        throw new PrismError({
          statusCode: 400,
          type: 'invalid_request_error',
          message:
            'Multi-model verification needs a checker model that is different from the writer. Set verification models on the plan.',
        });
      }
      if (!hasVerificationRoom(session)) {
        throw new PrismError({
          statusCode: 402,
          type: 'budget_exceeded',
          message: 'Not enough token limit left for multi-model verification',
        });
      }
      let result;
      try {
        result = await verifyAcrossModels({
          base,
          virtualKey: session.virtual_key,
          writer: requestedModel,
          checkers,
          messages,
        });
      } catch (err) {
        const statusCode = err.statusCode || 502;
        return reply.status(statusCode).send(
          err.body || {
            error: {
              message: err.message || 'Verification failed',
              type: 'upstream_error',
            },
          },
        );
      }

      const assistant = result.content;
      const lastUser = lastUserText(messages);
      const turns = [];
      if (lastUser) {
        turns.push({ role: 'user', content: lastUser });
      }
      if (assistant) {
        turns.push({
          role: 'assistant',
          content: assistant,
          verified: result.verified,
        });
      }
      if (turns.length) {
        appendConversationMessages(conversationId, session.user_id, turns);
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'x-prism-conversation-id': String(conversationId),
        'x-prism-provider': result.provider || requestedModel,
        'x-prism-verified': result.verified ? 'true' : 'false',
      });
      writeVerifiedSse(reply.raw, assistant);
      reply.raw.end();
      return;
    }

    const upstream = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: chatProxyHeaders(session.virtual_key),
      body: JSON.stringify({
        model: requestedModel,
        messages,
        stream: true,
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text();
      let parsed;
      try {
        parsed = JSON.parse(errText);
      } catch {
        parsed = {
          error: {
            message: errText || `Chat upstream HTTP ${upstream.status}`,
            type: 'upstream_error',
          },
        };
      }
      return reply.status(upstream.status).send(parsed);
    }

    reply.hijack();
    const headers = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'x-prism-conversation-id': String(conversationId),
    };
    for (const name of [
      'x-prism-provider',
      'x-prism-cache',
      'x-prism-fallback',
      'x-prism-escalation',
    ]) {
      const value = upstream.headers.get(name);
      if (value) {
        headers[name] = value;
      }
    }
    reply.raw.writeHead(upstream.status, headers);

    const reader = upstream.body.getReader();
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        chunks.push(value);
        reply.raw.write(value);
      }

      const sseText = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString(
        'utf8',
      );
      const assistant = extractAssistantFromSse(sseText);
      const lastUser = [...messages]
        .reverse()
        .find((m) => m?.role === 'user' && String(m.content || '').trim());
      const turns = [];
      if (lastUser) {
        turns.push({ role: 'user', content: String(lastUser.content) });
      }
      if (assistant) {
        turns.push({ role: 'assistant', content: assistant });
      }
      if (turns.length) {
        try {
          appendConversationMessages(conversationId, session.user_id, turns);
        } catch {
          /* reply already streamed; do not fail the client */
        }
      }
      reply.raw.end();
    } catch {
      try {
        reply.raw.end();
      } catch {
        /* ignore */
      }
    }
  });
}
