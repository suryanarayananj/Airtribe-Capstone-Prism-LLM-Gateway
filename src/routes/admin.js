import { assertAdminAuth } from '../adminAuth.js';
import { getProcessCacheStats } from '../cache.js';
import { config, getProviderCatalog } from '../config.js';
import {
  clearAdminTable,
  countCacheEntries,
  countCacheHits,
  countRequestLogs,
  createAccessUser,
  createManagedKey,
  createPlan,
  createTeam,
  deleteAdminRecord,
  disableVirtualKey,
  enableVirtualKey,
  getAdminLogs,
  getAdminUsage,
  getObservabilityStats,
  listAccessUsers,
  listAdminCacheEntries,
  listAdminCacheHits,
  listAdminKeys,
  listPlans,
  listTeams,
  rotateVirtualKey,
  updateAccessUser,
  updatePlan,
  updateTeam,
} from '../db.js';
import { PrismError } from '../errors.js';
import {
  GUARDRAIL_MODES,
  normalizeGuardrailMode,
} from '../guardrails.js';
import { getRoutingStrategy, listProviderHealth } from '../health.js';
import { hashPassword } from '../passwords.js';

function assignableModels() {
  // Plans allowlist friendly aliases only — slots (alpha-small, …) stay internal.
  const preferred = ['auto', 'fast', 'smart'];
  const names = Object.keys(config.modelAliases || {});
  return [...names].sort((a, b) => {
    const ia = preferred.indexOf(a);
    const ib = preferred.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
}

function asAdminError(err) {
  if (err instanceof PrismError) {
    throw err;
  }
  const message = err?.message || 'Request failed';
  const conflict = /UNIQUE/i.test(message);
  throw new PrismError({
    statusCode: conflict ? 409 : 400,
    type: 'invalid_request_error',
    message,
  });
}

function parsePlanBody(body) {
  const name = String(body?.name || '').trim();
  if (!name) {
    throw new PrismError({
      statusCode: 400,
      type: 'invalid_request_error',
      message: 'Plan name is required',
    });
  }

  const models = assignableModels();
  const allow = Array.isArray(body?.model_allowlist) ? body.model_allowlist : [];
  const picked = [...new Set(allow.map((item) => String(item)))];
  if (!picked.length || picked.some((model) => !models.includes(model))) {
    throw new PrismError({
      statusCode: 400,
      type: 'invalid_request_error',
      message: `Choose at least one model from: ${models.join(', ')}`,
    });
  }
  const verifyRaw = Array.isArray(body?.verify_models) ? body.verify_models : [];
  const verifyModels = [...new Set(verifyRaw.map((item) => String(item)))].filter((model) =>
    picked.includes(model),
  );

  const budget = Number(body?.monthly_budget_usd);
  const rpm = Number(body?.rpm_limit);
  if (!Number.isFinite(budget) || budget < 0 || !Number.isFinite(rpm) || rpm < 1) {
    throw new PrismError({
      statusCode: 400,
      type: 'invalid_request_error',
      message: 'monthly budget must be >= 0 and rpm limit must be >= 1',
    });
  }

  const tpm =
    body?.tpm_limit === '' || body?.tpm_limit == null
      ? null
      : Number(body.tpm_limit);
  const cap =
    body?.token_cap === '' || body?.token_cap == null
      ? null
      : Number(body.token_cap);
  const similarity = Number(body?.cache_similarity ?? 0.92);
  const guardrailInjection = normalizeGuardrailMode(
    body?.guardrail_injection,
    'block',
  );
  const guardrailPii = normalizeGuardrailMode(body?.guardrail_pii, 'flag');
  if (
    !GUARDRAIL_MODES.includes(guardrailInjection) ||
    !GUARDRAIL_MODES.includes(guardrailPii)
  ) {
    throw new PrismError({
      statusCode: 400,
      type: 'invalid_request_error',
      message: `guardrail modes must be one of: ${GUARDRAIL_MODES.join(', ')}`,
    });
  }

  return {
    name,
    monthlyBudgetUsd: budget,
    rpmLimit: Math.floor(rpm),
    tpmLimit: Number.isFinite(tpm) ? Math.floor(tpm) : null,
    tokenCap: Number.isFinite(cap) ? Math.floor(cap) : null,
    modelAllowlist: picked,
    verifyModels,
    cacheEnabled: Boolean(body?.cache_enabled),
    cacheSimilarity: Number.isFinite(similarity) ? similarity : 0.92,
    guardrailInjection,
    guardrailPii,
  };
}

function parseUserBody(body, { requirePassword }) {
  const name = String(body?.name || '').trim();
  const username = String(body?.username || '').trim().toLowerCase();
  const password = String(body?.password || '');
  const team = String(body?.team || '').trim();
  const accessMode = String(body?.access_mode || 'both')
    .trim()
    .toLowerCase();

  if (!name || !username || !team) {
    throw new PrismError({
      statusCode: 400,
      type: 'invalid_request_error',
      message: 'name, username, and team are required',
    });
  }
  if (!['api', 'chat', 'both'].includes(accessMode)) {
    throw new PrismError({
      statusCode: 400,
      type: 'invalid_request_error',
      message: 'access_mode must be api, chat, or both',
    });
  }
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw new PrismError({
      statusCode: 400,
      type: 'invalid_request_error',
      message: 'username must be 3–32 characters: letters, numbers, . _ -',
    });
  }
  const needsPassword = requirePassword && accessMode !== 'api';
  if (needsPassword && password.length < 4) {
    throw new PrismError({
      statusCode: 400,
      type: 'invalid_request_error',
      message: 'password must be at least 4 characters for Chat or Both',
    });
  }
  if (!requirePassword && password && password.length < 4) {
    throw new PrismError({
      statusCode: 400,
      type: 'invalid_request_error',
      message: 'password must be at least 4 characters',
    });
  }

  return { name, username, password, team, accessMode };
}

/**
 * Admin APIs (demo token). Usage shape matches pack contract for load-test compare.
 * @param {import('fastify').FastifyInstance} app
 */
export async function registerAdminRoutes(app) {
  app.addHook('preHandler', async (request) => {
    const path = request.url.split('?')[0];
    if (!path.startsWith('/admin')) {
      return;
    }
    assertAdminAuth(request.headers.authorization);
  });

  app.get('/admin/cache/stats', async () => {
    const processStats = getProcessCacheStats();
    return {
      hits: processStats.process_hits,
      misses: processStats.process_misses,
      /** Live (this process) — kept for backward compatibility. */
      hit_rate: processStats.process_hit_rate,
      entries: processStats.entries,
      cumulative_entry_hits: processStats.cumulative_entry_hits,
      ...processStats,
    };
  });

  app.get('/admin/usage', async (request) => {
    const q = request.query || {};
    return getAdminUsage({
      virtualKey: q.key || null,
      from: q.from || null,
      to: q.to || null,
    });
  });

  app.get('/admin/providers/health', async () => ({
    routing_strategy: getRoutingStrategy(),
    providers: listProviderHealth(),
  }));

  app.get('/admin/providers/catalog', async () => getProviderCatalog());

  app.get('/admin/observability', async (request) => {
    const q = request.query || {};
    return getObservabilityStats({
      virtualKey: q.key || null,
      from: q.from || null,
      to: q.to || null,
    });
  });

  app.get('/admin/logs', async (request) => {
    const q = request.query || {};
    const logs = getAdminLogs({
      virtualKey: q.key || null,
      limit: q.limit ? Number(q.limit) : 50,
    });
    return { logs, total: countRequestLogs() };
  });

  app.get('/admin/cache/entries', async (request) => {
    const limit = request.query?.limit ? Number(request.query.limit) : 200;
    return {
      entries: listAdminCacheEntries(limit),
      total: countCacheEntries(),
    };
  });

  app.get('/admin/cache/hits', async (request) => {
    const limit = request.query?.limit ? Number(request.query.limit) : 200;
    return {
      hits: listAdminCacheHits(limit),
      total: countCacheHits(),
    };
  });

  app.get('/admin/keys', async () => ({ keys: listAdminKeys() }));

  app.post('/admin/keys', async (request) => {
    try {
      const body = request.body || {};
      const key = createManagedKey({
        team: body.team,
        planId: body.plan_id,
        userId: body.user_id,
        monthlyBudgetUsd: body.monthly_budget_usd,
        rpmLimit: body.rpm_limit,
        tpmLimit: body.tpm_limit,
        tokenCap: body.token_cap,
        modelAllowlist: body.model_allowlist,
        verifyModels: body.verify_models,
        cacheEnabled:
          body.cache_enabled == null ? true : Boolean(body.cache_enabled),
        cacheSimilarity: body.cache_similarity,
      });
      return { key };
    } catch (err) {
      asAdminError(err);
    }
  });

  app.post('/admin/keys/:id/disable', async (request) => {
    try {
      const key = disableVirtualKey(Number(request.params.id));
      return { key };
    } catch (err) {
      const message = err?.message || 'Request failed';
      if (/not found/i.test(message)) {
        throw new PrismError({
          statusCode: 404,
          type: 'not_found_error',
          message,
        });
      }
      asAdminError(err);
    }
  });

  app.post('/admin/keys/:id/enable', async (request) => {
    try {
      const key = enableVirtualKey(Number(request.params.id));
      return { key };
    } catch (err) {
      const message = err?.message || 'Request failed';
      if (/not found/i.test(message)) {
        throw new PrismError({
          statusCode: 404,
          type: 'not_found_error',
          message,
        });
      }
      asAdminError(err);
    }
  });

  app.post('/admin/keys/:id/rotate', async (request) => {
    try {
      const key = rotateVirtualKey(Number(request.params.id));
      return { key };
    } catch (err) {
      const message = err?.message || 'Request failed';
      if (/not found/i.test(message)) {
        throw new PrismError({
          statusCode: 404,
          type: 'not_found_error',
          message,
        });
      }
      asAdminError(err);
    }
  });

  app.get('/admin/models', async () => ({ models: assignableModels() }));

  app.get('/admin/plans', async () => ({ plans: listPlans() }));

  app.post('/admin/plans', async (request) => {
    try {
      return createPlan(parsePlanBody(request.body));
    } catch (err) {
      asAdminError(err);
    }
  });

  app.patch('/admin/plans/:id', async (request) => {
    try {
      return updatePlan(Number(request.params.id), parsePlanBody(request.body));
    } catch (err) {
      asAdminError(err);
    }
  });

  app.get('/admin/teams', async () => ({ teams: listTeams() }));

  app.post('/admin/teams', async (request) => {
    try {
      return createTeam({
        name: request.body?.name,
        planId: Number(request.body?.plan_id),
      });
    } catch (err) {
      asAdminError(err);
    }
  });

  app.patch('/admin/teams/:id', async (request) => {
    try {
      return updateTeam(Number(request.params.id), {
        name: request.body?.name,
        planId: Number(request.body?.plan_id),
      });
    } catch (err) {
      asAdminError(err);
    }
  });

  app.get('/admin/users', async () => ({ users: listAccessUsers() }));

  app.post('/admin/users', async (request) => {
    try {
      const body = parseUserBody(request.body, { requirePassword: true });
      return createAccessUser({
        name: body.name,
        username: body.username,
        passwordHash: body.password ? hashPassword(body.password) : null,
        team: body.team,
        accessMode: body.accessMode,
      });
    } catch (err) {
      asAdminError(err);
    }
  });

  app.patch('/admin/users/:id', async (request) => {
    try {
      const body = parseUserBody(request.body, { requirePassword: false });
      return updateAccessUser(Number(request.params.id), {
        name: body.name,
        username: body.username,
        passwordHash: body.password ? hashPassword(body.password) : null,
        team: body.team,
        accessMode: body.accessMode,
      });
    } catch (err) {
      asAdminError(err);
    }
  });

  app.delete('/admin/records/:table/:id', async (request) => {
    try {
      return deleteAdminRecord(request.params.table, request.params.id);
    } catch (err) {
      asAdminError(err);
    }
  });

  app.delete('/admin/records/:table', async (request) => {
    try {
      return clearAdminTable(request.params.table);
    } catch (err) {
      asAdminError(err);
    }
  });
}
