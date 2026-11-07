import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { hashPassword } from './passwords.js';

/** @type {DatabaseSync | null} */
let db = null;

export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function initDb() {
  const dir = path.dirname(config.dbPath);
  fs.mkdirSync(dir, { recursive: true });

  db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  createSchema(db);
  ensureCacheHitSchema(db);
  ensureAccessSchema(db);
  db.exec('DROP TABLE IF EXISTS upstream_settings');
  seedIfNeeded(db);
  ensureKeyOwnership(db);
  ensureDemoChatUser();
  return db;
}

/** @param {unknown} mode */
export function normalizeAccessMode(mode) {
  const value = String(mode || '')
    .trim()
    .toLowerCase();
  if (value === 'api' || value === 'chat' || value === 'both') {
    return value;
  }
  return 'both';
}

/** True when this mode may call /v1 with the virtual key (external API). */
export function accessModeAllowsApi(mode) {
  const normalized = normalizeAccessMode(mode);
  return normalized === 'api' || normalized === 'both';
}

/** True when this mode may sign in to the chat app. */
export function accessModeAllowsChat(mode) {
  const normalized = normalizeAccessMode(mode);
  return normalized === 'chat' || normalized === 'both';
}

/**
 * @param {DatabaseSync} database
 */
function createSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      team TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      token_cap INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS virtual_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      virtual_key TEXT NOT NULL UNIQUE,
      team TEXT NOT NULL,
      user_id INTEGER,
      monthly_budget_usd REAL NOT NULL,
      rpm_limit INTEGER NOT NULL,
      tpm_limit INTEGER,
      token_cap INTEGER,
      model_allowlist TEXT NOT NULL,
      cache_enabled INTEGER NOT NULL DEFAULT 1,
      cache_similarity REAL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      virtual_key TEXT NOT NULL,
      year_month TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      cache_hits INTEGER NOT NULL DEFAULT 0,
      UNIQUE (virtual_key, year_month)
    );

    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      virtual_key TEXT,
      requested_model TEXT,
      resolved_provider TEXT,
      resolved_model TEXT,
      status TEXT NOT NULL,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      cache TEXT,
      fallback INTEGER DEFAULT 0,
      route_reason TEXT,
      retries INTEGER DEFAULT 0,
      latency_ms INTEGER,
      error_type TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cache_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      virtual_key TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_hash TEXT,
      embedding BLOB,
      response_json TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_virtual_keys_key ON virtual_keys(virtual_key);
    CREATE INDEX IF NOT EXISTS idx_usage_key_month ON usage(virtual_key, year_month);
    CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_cache_vk_model ON cache_entries(virtual_key, model);
  `);
}

/**
 * Prompt text on entries, plus one row per cache hit.
 * @param {DatabaseSync} database
 */
function ensureCacheHitSchema(database) {
  const cols = database.prepare('PRAGMA table_info(cache_entries)').all();
  if (!cols.some((col) => col.name === 'prompt_text')) {
    database.exec('ALTER TABLE cache_entries ADD COLUMN prompt_text TEXT');
  }
  if (!cols.some((col) => col.name === 'expires_at')) {
    database.exec('ALTER TABLE cache_entries ADD COLUMN expires_at TEXT');
  }
  const keyCols = database.prepare('PRAGMA table_info(virtual_keys)').all();
  if (keyCols.length && !keyCols.some((col) => col.name === 'cache_ttl_seconds')) {
    database.exec('ALTER TABLE virtual_keys ADD COLUMN cache_ttl_seconds INTEGER');
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS cache_hits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cache_entry_id INTEGER,
      request_id TEXT,
      virtual_key TEXT NOT NULL,
      model TEXT NOT NULL,
      score REAL,
      prompt_text TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (cache_entry_id) REFERENCES cache_entries(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cache_hits_entry ON cache_hits(cache_entry_id);
    CREATE INDEX IF NOT EXISTS idx_cache_hits_created ON cache_hits(created_at);
  `);
}

/**
 * Plans, teams with a plan, login names, and chat sessions.
 * Same plan rules → separate meters (one virtual key per user).
 * @param {DatabaseSync} database
 */
function ensureAccessSchema(database) {
  const userCols = database.prepare('PRAGMA table_info(users)').all();
  if (!userCols.some((col) => col.name === 'username')) {
    database.exec('ALTER TABLE users ADD COLUMN username TEXT');
  }
  if (!userCols.some((col) => col.name === 'password_hash')) {
    database.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
  }
  if (!userCols.some((col) => col.name === 'access_mode')) {
    database.exec(
      "ALTER TABLE users ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'both'",
    );
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      monthly_budget_usd REAL NOT NULL,
      rpm_limit INTEGER NOT NULL,
      tpm_limit INTEGER,
      token_cap INTEGER,
      model_allowlist TEXT NOT NULL,
      cache_enabled INTEGER NOT NULL DEFAULT 0,
      cache_similarity REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
      ON users(username) WHERE username IS NOT NULL;
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      plan_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (plan_id) REFERENCES plans(id)
    );
    CREATE TABLE IF NOT EXISTS chat_sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT 'New chat',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_user
      ON conversations(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conversation_messages_conv
      ON conversation_messages(conversation_id, id);
  `);

  const planCols = database.prepare('PRAGMA table_info(plans)').all();
  if (planCols.length && !planCols.some((col) => col.name === 'verify_models')) {
    database.exec(
      "ALTER TABLE plans ADD COLUMN verify_models TEXT NOT NULL DEFAULT '[]'",
    );
  }
  if (planCols.length && !planCols.some((col) => col.name === 'guardrail_injection')) {
    database.exec(
      "ALTER TABLE plans ADD COLUMN guardrail_injection TEXT NOT NULL DEFAULT 'block'",
    );
  }
  if (planCols.length && !planCols.some((col) => col.name === 'guardrail_pii')) {
    database.exec(
      "ALTER TABLE plans ADD COLUMN guardrail_pii TEXT NOT NULL DEFAULT 'flag'",
    );
  }
  const keyCols = database.prepare('PRAGMA table_info(virtual_keys)').all();
  if (keyCols.length && !keyCols.some((col) => col.name === 'verify_models')) {
    database.exec(
      "ALTER TABLE virtual_keys ADD COLUMN verify_models TEXT NOT NULL DEFAULT '[]'",
    );
  }
  if (keyCols.length && !keyCols.some((col) => col.name === 'guardrail_injection')) {
    database.exec(
      "ALTER TABLE virtual_keys ADD COLUMN guardrail_injection TEXT NOT NULL DEFAULT 'block'",
    );
  }
  if (keyCols.length && !keyCols.some((col) => col.name === 'guardrail_pii')) {
    database.exec(
      "ALTER TABLE virtual_keys ADD COLUMN guardrail_pii TEXT NOT NULL DEFAULT 'flag'",
    );
  }
  const messageCols = database.prepare('PRAGMA table_info(conversation_messages)').all();
  if (messageCols.length && !messageCols.some((col) => col.name === 'verified')) {
    database.exec(
      'ALTER TABLE conversation_messages ADD COLUMN verified INTEGER NOT NULL DEFAULT 0',
    );
  }

  const teamCols = database.prepare('PRAGMA table_info(teams)').all();
  if (!teamCols.some((col) => col.name === 'plan_id')) {
    database.exec('ALTER TABLE teams ADD COLUMN plan_id INTEGER');
  }

  seedPlansAndTeams(database);
}

/**
 * One plan per seeded tenant; attach each team to that plan.
 * @param {DatabaseSync} database
 */
function seedPlansAndTeams(database) {
  const insertPlan = database.prepare(`
    INSERT OR IGNORE INTO plans (
      name, monthly_budget_usd, rpm_limit, tpm_limit, token_cap,
      model_allowlist, cache_enabled, cache_similarity
    ) VALUES (
      @name, @monthly_budget_usd, @rpm_limit, @tpm_limit, @token_cap,
      @model_allowlist, @cache_enabled, @cache_similarity
    )
  `);
  const findPlan = database.prepare('SELECT id FROM plans WHERE name = ?');
  const insertTeam = database.prepare(
    'INSERT OR IGNORE INTO teams (name, plan_id) VALUES (?, ?)',
  );
  const setTeamPlan = database.prepare(
    'UPDATE teams SET plan_id = ? WHERE name = ? AND (plan_id IS NULL OR plan_id = 0)',
  );

  for (const tenant of config.seedTenants) {
    const planName = `${tenant.team}-plan`;
    insertPlan.run({
      name: planName,
      monthly_budget_usd: tenant.monthly_budget_usd,
      rpm_limit: tenant.rate_limit.requests_per_minute,
      tpm_limit: tenant.rate_limit.tokens_per_minute ?? null,
      token_cap: null,
      model_allowlist: JSON.stringify(tenant.model_allowlist),
      cache_enabled: tenant.semantic_cache?.enabled ? 1 : 0,
      cache_similarity: tenant.semantic_cache?.similarity_threshold ?? 0.92,
    });
    const plan = findPlan.get(planName);
    insertTeam.run(tenant.team, plan?.id ?? null);
    if (plan?.id) {
      setTeamPlan.run(plan.id, tenant.team);
    }
  }

  for (const row of database.prepare('SELECT DISTINCT team AS name FROM users').all()) {
    if (row.name) {
      insertTeam.run(row.name, null);
    }
  }
}

function mapPlanRow(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    model_allowlist: JSON.parse(row.model_allowlist || '[]'),
    verify_models: JSON.parse(row.verify_models || '[]'),
    cache_enabled: Boolean(row.cache_enabled),
    guardrail_injection: row.guardrail_injection || 'block',
    guardrail_pii: row.guardrail_pii || 'flag',
  };
}

function applyPlanToUserKey(database, userId, teamName, plan) {
  const existing = database
    .prepare(
      `SELECT id FROM virtual_keys
       WHERE user_id = ? AND status = 'active'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(userId);

  if (existing) {
    database
      .prepare(
        `UPDATE virtual_keys SET
           team = ?,
           monthly_budget_usd = ?,
           rpm_limit = ?,
           tpm_limit = ?,
           token_cap = ?,
           model_allowlist = ?,
           verify_models = ?,
           cache_enabled = ?,
           cache_similarity = ?,
           guardrail_injection = ?,
           guardrail_pii = ?
         WHERE id = ?`,
      )
      .run(
        teamName,
        plan.monthly_budget_usd,
        plan.rpm_limit,
        plan.tpm_limit,
        plan.token_cap,
        JSON.stringify(plan.model_allowlist),
        JSON.stringify(plan.verify_models || []),
        plan.cache_enabled ? 1 : 0,
        plan.cache_similarity,
        plan.guardrail_injection || 'block',
        plan.guardrail_pii || 'flag',
        existing.id,
      );
    return existing.id;
  }

  const virtualKey = `prism-sk-${randomBytes(9).toString('hex')}`;
  const result = database
    .prepare(
      `INSERT INTO virtual_keys (
         virtual_key, team, user_id, monthly_budget_usd, rpm_limit, tpm_limit,
         token_cap, model_allowlist, verify_models, cache_enabled, cache_similarity,
         guardrail_injection, guardrail_pii, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    )
    .run(
      virtualKey,
      teamName,
      userId,
      plan.monthly_budget_usd,
      plan.rpm_limit,
      plan.tpm_limit,
      plan.token_cap,
      JSON.stringify(plan.model_allowlist),
      JSON.stringify(plan.verify_models || []),
      plan.cache_enabled ? 1 : 0,
      plan.cache_similarity,
      plan.guardrail_injection || 'block',
      plan.guardrail_pii || 'flag',
    );
  return Number(result.lastInsertRowid);
}

/**
 * Idempotent seed from data/seed_keys.json — preserves pack key strings.
 * @param {DatabaseSync} database
 */
function seedIfNeeded(database) {
  const insertUser = database.prepare(`
    INSERT INTO users (name, team, status, token_cap, username, access_mode)
    VALUES (@name, @team, 'active', @token_cap, @username, 'api')
  `);

  const insertKey = database.prepare(`
    INSERT INTO virtual_keys (
      virtual_key, team, user_id, monthly_budget_usd, rpm_limit, tpm_limit,
      model_allowlist, cache_enabled, cache_similarity, status
    ) VALUES (
      @virtual_key, @team, @user_id, @monthly_budget_usd, @rpm_limit, @tpm_limit,
      @model_allowlist, @cache_enabled, @cache_similarity, 'active'
    )
  `);

  const findKey = database.prepare(
    'SELECT id FROM virtual_keys WHERE virtual_key = ?',
  );

  database.exec('BEGIN');
  try {
    for (const tenant of config.seedTenants) {
      if (findKey.get(tenant.virtual_key)) {
        continue;
      }

      const username = `api-${tenant.team}`.replaceAll(/[^a-z0-9._-]/gi, '-');
      const userResult = insertUser.run({
        name: `${tenant.team} API`,
        team: tenant.team,
        token_cap: tenant.rate_limit?.tokens_per_minute ?? null,
        username,
      });

      insertKey.run({
        virtual_key: tenant.virtual_key,
        team: tenant.team,
        user_id: Number(userResult.lastInsertRowid),
        monthly_budget_usd: tenant.monthly_budget_usd,
        rpm_limit: tenant.rate_limit.requests_per_minute,
        tpm_limit: tenant.rate_limit.tokens_per_minute ?? null,
        model_allowlist: JSON.stringify(tenant.model_allowlist),
        cache_enabled: tenant.semantic_cache?.enabled ? 1 : 0,
        cache_similarity: tenant.semantic_cache?.similarity_threshold ?? null,
      });
    }
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Every virtual key must belong to a user. Pack seeds are API-only owners.
 * Safe to re-run on existing databases.
 * @param {DatabaseSync} database
 */
function ensureKeyOwnership(database) {
  const seedByKey = new Map(
    config.seedTenants.map((tenant) => [tenant.virtual_key, tenant]),
  );

  database.exec('BEGIN');
  try {
    for (const tenant of config.seedTenants) {
      const key = database
        .prepare('SELECT * FROM virtual_keys WHERE virtual_key = ?')
        .get(tenant.virtual_key);
      if (!key) {
        continue;
      }
      let userId = key.user_id;
      if (!userId) {
        const username = `api-${tenant.team}`.replaceAll(/[^a-z0-9._-]/gi, '-');
        const inserted = database
          .prepare(
            `INSERT INTO users (name, team, status, token_cap, username, access_mode)
             VALUES (?, ?, 'active', ?, ?, 'api')`,
          )
          .run(
            `${tenant.team} API`,
            tenant.team,
            tenant.rate_limit?.tokens_per_minute ?? null,
            username,
          );
        userId = Number(inserted.lastInsertRowid);
        database
          .prepare('UPDATE virtual_keys SET user_id = ? WHERE id = ?')
          .run(userId, key.id);
      } else {
        database
          .prepare(
            `UPDATE users SET
               access_mode = 'api',
               username = COALESCE(NULLIF(username, ''), ?),
               name = CASE
                 WHEN name IS NULL OR name = '' OR name LIKE '%-default'
                   THEN ?
                 ELSE name
               END
             WHERE id = ?`,
          )
          .run(
            `api-${tenant.team}`.replaceAll(/[^a-z0-9._-]/gi, '-'),
            `${tenant.team} API`,
            userId,
          );
      }
    }

    const orphans = database
      .prepare(
        `SELECT id, team, virtual_key FROM virtual_keys
         WHERE user_id IS NULL OR user_id = 0`,
      )
      .all();
    for (const orphan of orphans) {
      if (seedByKey.has(orphan.virtual_key)) {
        continue;
      }
      const username = `api-key-${orphan.id}`;
      const inserted = database
        .prepare(
          `INSERT INTO users (name, team, status, username, access_mode)
           VALUES (?, ?, 'active', ?, 'api')`,
        )
        .run(`${orphan.team} API key`, orphan.team, username);
      database
        .prepare('UPDATE virtual_keys SET user_id = ? WHERE id = ?')
        .run(Number(inserted.lastInsertRowid), orphan.id);
    }

    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

/**
 * @param {string} virtualKey
 * @returns {object | undefined}
 */
export function findVirtualKey(virtualKey) {
  return getDb()
    .prepare('SELECT * FROM virtual_keys WHERE virtual_key = ?')
    .get(virtualKey);
}

/**
 * @param {number} userId
 * @returns {object | undefined}
 */
export function getUserById(userId) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

/**
 * @param {string} virtualKey
 * @param {string} yearMonth
 * @returns {object | undefined}
 */
export function getMonthlyUsage(virtualKey, yearMonth) {
  return getDb()
    .prepare(
      'SELECT * FROM usage WHERE virtual_key = ? AND year_month = ?',
    )
    .get(virtualKey, yearMonth);
}

/**
 * Atomically upsert monthly usage totals.
 * @param {object} fields
 */
export function incrementUsage({
  virtualKey,
  yearMonth,
  requests = 1,
  promptTokens = 0,
  completionTokens = 0,
  costUsd = 0,
  cacheHits = 0,
}) {
  const database = getDb();
  database.exec('BEGIN IMMEDIATE');
  try {
    database
      .prepare(
        `
        INSERT INTO usage (
          virtual_key, year_month, requests, prompt_tokens,
          completion_tokens, cost_usd, cache_hits
        ) VALUES (
          @virtual_key, @year_month, @requests, @prompt_tokens,
          @completion_tokens, @cost_usd, @cache_hits
        )
        ON CONFLICT(virtual_key, year_month) DO UPDATE SET
          requests = requests + excluded.requests,
          prompt_tokens = prompt_tokens + excluded.prompt_tokens,
          completion_tokens = completion_tokens + excluded.completion_tokens,
          cost_usd = cost_usd + excluded.cost_usd,
          cache_hits = cache_hits + excluded.cache_hits
      `,
      )
      .run({
        virtual_key: virtualKey,
        year_month: yearMonth,
        requests,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        cost_usd: costUsd,
        cache_hits: cacheHits,
      });
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

/**
 * @param {object} entry
 */
export function insertRequestLog(entry) {
  getDb()
    .prepare(
      `
      INSERT INTO request_logs (
        request_id, virtual_key, requested_model, resolved_provider,
        resolved_model, status, prompt_tokens, completion_tokens, cost_usd,
        cache, fallback, route_reason, retries, latency_ms, error_type
      ) VALUES (
        @request_id, @virtual_key, @requested_model, @resolved_provider,
        @resolved_model, @status, @prompt_tokens, @completion_tokens, @cost_usd,
        @cache, @fallback, @route_reason, @retries, @latency_ms, @error_type
      )
    `,
    )
    .run({
      request_id: entry.requestId,
      virtual_key: entry.virtualKey ?? null,
      requested_model: entry.requestedModel ?? null,
      resolved_provider: entry.resolvedProvider ?? null,
      resolved_model: entry.resolvedModel ?? null,
      status: entry.status,
      prompt_tokens: entry.promptTokens ?? 0,
      completion_tokens: entry.completionTokens ?? 0,
      cost_usd: entry.costUsd ?? 0,
      cache: entry.cache ?? null,
      fallback: entry.fallback ? 1 : 0,
      route_reason: entry.routeReason ?? null,
      retries: entry.retries ?? 0,
      latency_ms: entry.latencyMs ?? null,
      error_type: entry.errorType ?? null,
    });
}

/**
 * @returns {string[]}
 */
export function listSeededVirtualKeys() {
  return getDb()
    .prepare('SELECT virtual_key FROM virtual_keys ORDER BY id')
    .all()
    .map((row) => row.virtual_key);
}

/**
 * @param {string} virtualKey
 * @param {string} model
 */
export function getCacheEntriesForKeyModel(virtualKey, model) {
  return getDb()
    .prepare(
      `SELECT id, virtual_key, model, embedding, response_json, hit_count, expires_at
       FROM cache_entries
       WHERE virtual_key = ? AND model = ?
         AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`,
    )
    .all(virtualKey, model);
}

/**
 * @param {object} entry
 */
export function insertCacheEntry({
  virtualKey,
  model,
  promptHash,
  promptText,
  embedding,
  responseJson,
  expiresAt = null,
}) {
  getDb()
    .prepare(
      `INSERT INTO cache_entries (
         virtual_key, model, prompt_hash, prompt_text, embedding, response_json, hit_count, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      virtualKey,
      model,
      promptHash,
      promptText ?? null,
      embedding,
      responseJson,
      expiresAt ?? null,
    );
}

/**
 * One row for each time a stored entry is served.
 * @param {object} hit
 */
export function insertCacheHit({
  cacheEntryId,
  requestId,
  virtualKey,
  model,
  score,
  promptText,
}) {
  getDb()
    .prepare(
      `INSERT INTO cache_hits (
         cache_entry_id, request_id, virtual_key, model, score, prompt_text
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      cacheEntryId ?? null,
      requestId ?? null,
      virtualKey,
      model,
      score ?? null,
      promptText ?? null,
    );
}

/**
 * @param {number} id
 */
export function incrementCacheHitCount(id) {
  getDb()
    .prepare(
      'UPDATE cache_entries SET hit_count = hit_count + 1 WHERE id = ?',
    )
    .run(id);
}

export function getCacheEntryStats() {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS entries, COALESCE(SUM(hit_count), 0) AS hit_count_sum
       FROM cache_entries`,
    )
    .get();
  return {
    entries: Number(row?.entries || 0),
    hitCountSum: Number(row?.hit_count_sum || 0),
  };
}

/** Lifetime cache hit rate from persisted request_logs (survives restarts). */
export function getLifetimeCacheHitStats() {
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN cache = 'hit' THEN 1 ELSE 0 END), 0) AS hits
       FROM request_logs
       WHERE cache IN ('hit', 'miss')`,
    )
    .get();
  const total = Number(row?.total || 0);
  const hits = Number(row?.hits || 0);
  return {
    lifetimeHits: hits,
    lifetimeRequests: total,
    lifetimeHitRate: total ? hits / total : 0,
  };
}

/**
 * Usage summary for admin / load-test reconciliation.
 * Prefers monthly usage row; also returns log-window aggregates when from/to set.
 */
export function getAdminUsage({ virtualKey = null, from = null, to = null } = {}) {
  const database = getDb();

  let usageQuery = 'SELECT * FROM usage';
  const usageParams = [];
  if (virtualKey) {
    usageQuery += ' WHERE virtual_key = ?';
    usageParams.push(virtualKey);
  }
  const usageRows = database.prepare(usageQuery).all(...usageParams);

  let logSql = `
    SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
      COALESCE(SUM(cost_usd), 0) AS cost_usd,
      COALESCE(SUM(CASE WHEN cache = 'hit' THEN 1 ELSE 0 END), 0) AS cache_hits
    FROM request_logs
    WHERE status IN ('ok', 'cache_hit')
  `;
  const logParams = [];
  if (virtualKey) {
    logSql += ' AND virtual_key = ?';
    logParams.push(virtualKey);
  }
  if (from) {
    logSql += ' AND date(created_at) >= date(?)';
    logParams.push(from);
  }
  if (to) {
    logSql += ' AND date(created_at) <= date(?)';
    logParams.push(to);
  }
  const logTotals = database.prepare(logSql).get(...logParams);

  const byTeam = database
    .prepare(
      `
      SELECT vk.team AS team,
             COUNT(rl.id) AS requests,
             COALESCE(SUM(rl.cost_usd), 0) AS cost_usd,
             COALESCE(SUM(rl.prompt_tokens + rl.completion_tokens), 0) AS tokens
      FROM request_logs rl
      JOIN virtual_keys vk ON vk.virtual_key = rl.virtual_key
      WHERE rl.status IN ('ok', 'cache_hit')
      ${virtualKey ? 'AND rl.virtual_key = ?' : ''}
      GROUP BY vk.team
    `,
    )
    .all(...(virtualKey ? [virtualKey] : []));

  const byUser = database
    .prepare(
      `
      SELECT u.name AS user,
             vk.team AS team,
             COUNT(rl.id) AS requests,
             COALESCE(SUM(rl.cost_usd), 0) AS cost_usd,
             COALESCE(SUM(rl.prompt_tokens + rl.completion_tokens), 0) AS tokens
      FROM request_logs rl
      JOIN virtual_keys vk ON vk.virtual_key = rl.virtual_key
      LEFT JOIN users u ON u.id = vk.user_id
      WHERE rl.status IN ('ok', 'cache_hit')
      ${virtualKey ? 'AND rl.virtual_key = ?' : ''}
      GROUP BY u.name, vk.team
    `,
    )
    .all(...(virtualKey ? [virtualKey] : []));

  const aliasNames = new Set(
    Object.keys(config.modelAliases || {}).filter(Boolean),
  );
  const knownModels = [
    ...new Set(
      (config.providers || []).flatMap((provider) => [
        `${provider.name}-small`,
        `${provider.name}-large`,
      ]),
    ),
  ];

  const byModelRows = database
    .prepare(
      `
      SELECT resolved_model AS model,
             COUNT(*) AS requests,
             COALESCE(SUM(cost_usd), 0) AS cost_usd,
             COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens
      FROM request_logs
      WHERE status IN ('ok', 'cache_hit')
        AND resolved_model IS NOT NULL
        AND resolved_model NOT IN (${[...aliasNames].map(() => '?').join(', ') || "''"})
      ${virtualKey ? 'AND virtual_key = ?' : ''}
      ${from ? 'AND date(created_at) >= date(?)' : ''}
      ${to ? 'AND date(created_at) <= date(?)' : ''}
      GROUP BY resolved_model
    `,
    )
    .all(
      ...aliasNames,
      ...(virtualKey ? [virtualKey] : []),
      ...(from ? [from] : []),
      ...(to ? [to] : []),
    );

  /** @type {Map<string, { model: string, requests: number, cost_usd: number, tokens: number }>} */
  const byModelMap = new Map(
    byModelRows.map((row) => [
      row.model,
      {
        model: row.model,
        requests: Number(row.requests || 0),
        cost_usd: Number(row.cost_usd || 0),
        tokens: Number(row.tokens || 0),
      },
    ]),
  );
  for (const model of knownModels) {
    if (!byModelMap.has(model)) {
      byModelMap.set(model, {
        model,
        requests: 0,
        cost_usd: 0,
        tokens: 0,
      });
    }
  }
  const byModel = [...byModelMap.values()].sort((a, b) =>
    a.model.localeCompare(b.model),
  );

  const byProvider = database
    .prepare(
      `
      SELECT strftime('%Y-%m', created_at) AS month,
             COALESCE(resolved_provider, 'unknown') AS provider,
             COUNT(*) AS requests,
             COALESCE(SUM(cost_usd), 0) AS cost_usd,
             COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens
      FROM request_logs
      WHERE status IN ('ok', 'cache_hit')
      ${virtualKey ? 'AND virtual_key = ?' : ''}
      ${from ? 'AND date(created_at) >= date(?)' : ''}
      ${to ? 'AND date(created_at) <= date(?)' : ''}
      GROUP BY strftime('%Y-%m', created_at),
               COALESCE(resolved_provider, 'unknown')
      ORDER BY month DESC, cost_usd DESC
    `,
    )
    .all(
      ...(virtualKey ? [virtualKey] : []),
      ...(from ? [from] : []),
      ...(to ? [to] : []),
    );

  const thisMonthRow = database
    .prepare(
      `
      SELECT
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens
      FROM request_logs
      WHERE status IN ('ok', 'cache_hit')
        AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
      ${virtualKey ? 'AND virtual_key = ?' : ''}
    `,
    )
    .get(...(virtualKey ? [virtualKey] : []));

  const daily = database
    .prepare(
      `
      SELECT date(created_at) AS day,
             COUNT(*) AS requests,
             COALESCE(SUM(cost_usd), 0) AS cost_usd,
             COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens
      FROM request_logs
      WHERE status IN ('ok', 'cache_hit')
      ${virtualKey ? 'AND virtual_key = ?' : ''}
      ${from ? 'AND date(created_at) >= date(?)' : ''}
      ${to ? 'AND date(created_at) <= date(?)' : ''}
      GROUP BY date(created_at)
      ORDER BY day ASC
    `,
    )
    .all(
      ...(virtualKey ? [virtualKey] : []),
      ...(from ? [from] : []),
      ...(to ? [to] : []),
    );

  const monthly = database
    .prepare(
      `
      SELECT strftime('%Y-%m', created_at) AS month,
             COUNT(*) AS requests,
             COALESCE(SUM(cost_usd), 0) AS cost_usd,
             COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens
      FROM request_logs
      WHERE status IN ('ok', 'cache_hit')
      ${virtualKey ? 'AND virtual_key = ?' : ''}
      ${from ? 'AND date(created_at) >= date(?)' : ''}
      ${to ? 'AND date(created_at) <= date(?)' : ''}
      GROUP BY strftime('%Y-%m', created_at)
      ORDER BY month ASC
    `,
    )
    .all(
      ...(virtualKey ? [virtualKey] : []),
      ...(from ? [from] : []),
      ...(to ? [to] : []),
    );

  const monthRow = virtualKey
    ? usageRows[0]
    : usageRows.reduce(
        (acc, row) => ({
          requests: (acc.requests || 0) + row.requests,
          prompt_tokens: (acc.prompt_tokens || 0) + row.prompt_tokens,
          completion_tokens:
            (acc.completion_tokens || 0) + row.completion_tokens,
          cost_usd: (acc.cost_usd || 0) + row.cost_usd,
          cache_hits: (acc.cache_hits || 0) + row.cache_hits,
        }),
        {
          requests: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          cost_usd: 0,
          cache_hits: 0,
        },
      );

  const overallCostUsd = Number(logTotals?.cost_usd ?? 0);

  return {
    key: virtualKey || 'all',
    from: from || null,
    to: to || null,
    requests: Number(monthRow?.requests ?? logTotals?.requests ?? 0),
    prompt_tokens: Number(
      monthRow?.prompt_tokens ?? logTotals?.prompt_tokens ?? 0,
    ),
    completion_tokens: Number(
      monthRow?.completion_tokens ?? logTotals?.completion_tokens ?? 0,
    ),
    cost_usd: Number(monthRow?.cost_usd ?? logTotals?.cost_usd ?? 0),
    overall_cost_usd: overallCostUsd,
    this_month_cost_usd: Number(thisMonthRow?.cost_usd ?? 0),
    this_month_tokens: Number(thisMonthRow?.tokens ?? 0),
    cache_hits: Number(monthRow?.cache_hits ?? logTotals?.cache_hits ?? 0),
    log_window: logTotals,
    usage_rows: usageRows,
    by_team: byTeam,
    by_user: byUser,
    by_model: byModel,
    by_provider: byProvider,
    daily,
    monthly,
  };
}

/**
 * Percentile of a sorted numeric array (nearest-rank).
 * @param {number[]} sorted
 * @param {number} p
 */
function percentileSorted(sorted, p) {
  if (!sorted.length) {
    return null;
  }
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

/**
 * Fuller observability from request_logs: gateway latency percentiles,
 * per-provider outcomes, and routing / alias breakdowns.
 *
 * @param {{ virtualKey?: string | null, from?: string | null, to?: string | null }} [opts]
 */
export function getObservabilityStats({
  virtualKey = null,
  from = null,
  to = null,
} = {}) {
  const database = getDb();
  const where = [];
  const params = [];
  if (virtualKey) {
    where.push('virtual_key = ?');
    params.push(virtualKey);
  }
  if (from) {
    where.push('date(created_at) >= date(?)');
    params.push(from);
  }
  if (to) {
    where.push('date(created_at) <= date(?)');
    params.push(to);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const latencyRows = database
    .prepare(
      `SELECT latency_ms FROM request_logs
       ${whereSql}${whereSql ? ' AND' : 'WHERE'} latency_ms IS NOT NULL
       ORDER BY latency_ms ASC`,
    )
    .all(...params)
    .map((row) => Number(row.latency_ms))
    .filter((ms) => Number.isFinite(ms));

  const latency = {
    samples: latencyRows.length,
    p50_ms: percentileSorted(latencyRows, 50),
    p95_ms: percentileSorted(latencyRows, 95),
    p99_ms: percentileSorted(latencyRows, 99),
    avg_ms:
      latencyRows.length === 0
        ? null
        : latencyRows.reduce((sum, ms) => sum + ms, 0) / latencyRows.length,
  };

  const byProvider = database
    .prepare(
      `
      SELECT
        COALESCE(resolved_provider, 'unknown') AS provider,
        COUNT(*) AS requests,
        COALESCE(SUM(CASE WHEN status IN ('ok', 'cache_hit') THEN 1 ELSE 0 END), 0) AS ok,
        COALESCE(SUM(CASE WHEN status NOT IN ('ok', 'cache_hit') THEN 1 ELSE 0 END), 0) AS errors,
        AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END) AS avg_latency_ms,
        COALESCE(SUM(CASE WHEN fallback = 1 THEN 1 ELSE 0 END), 0) AS fallbacks
      FROM request_logs
      ${whereSql}
      GROUP BY COALESCE(resolved_provider, 'unknown')
      ORDER BY requests DESC
    `,
    )
    .all(...params)
    .map((row) => ({
      provider: row.provider,
      requests: Number(row.requests || 0),
      ok: Number(row.ok || 0),
      errors: Number(row.errors || 0),
      error_rate:
        Number(row.requests || 0) === 0
          ? 0
          : Number(row.errors || 0) / Number(row.requests || 0),
      avg_latency_ms:
        row.avg_latency_ms == null ? null : Number(row.avg_latency_ms),
      fallbacks: Number(row.fallbacks || 0),
    }));

  const byRequestedModel = database
    .prepare(
      `
      SELECT
        COALESCE(requested_model, 'unknown') AS model,
        COUNT(*) AS requests,
        COALESCE(SUM(CASE WHEN status IN ('ok', 'cache_hit') THEN 1 ELSE 0 END), 0) AS ok,
        COALESCE(SUM(CASE WHEN cache = 'hit' THEN 1 ELSE 0 END), 0) AS cache_hits
      FROM request_logs
      ${whereSql}
      GROUP BY COALESCE(requested_model, 'unknown')
      ORDER BY requests DESC
    `,
    )
    .all(...params)
    .map((row) => ({
      model: row.model,
      requests: Number(row.requests || 0),
      ok: Number(row.ok || 0),
      cache_hits: Number(row.cache_hits || 0),
    }));

  const routingRows = database
    .prepare(
      `
      SELECT route_reason, COUNT(*) AS requests
      FROM request_logs
      ${whereSql}
      GROUP BY route_reason
      ORDER BY requests DESC
      LIMIT 40
    `,
    )
    .all(...params);

  /** @type {Record<string, number>} */
  const routingBuckets = {
    auto_fast: 0,
    auto_smart: 0,
    escalated: 0,
    guardrail_flag: 0,
    other: 0,
    none: 0,
  };
  for (const row of routingRows) {
    const reason = String(row.route_reason || '');
    const n = Number(row.requests || 0);
    if (!reason) {
      routingBuckets.none += n;
    } else if (/escalated/i.test(reason)) {
      routingBuckets.escalated += n;
    } else if (/fast\s*\(/i.test(reason) || /:\s*fast\b/i.test(reason)) {
      routingBuckets.auto_fast += n;
    } else if (/smart\s*\(/i.test(reason) || /:\s*smart\b/i.test(reason)) {
      routingBuckets.auto_smart += n;
    } else if (/flag|inject|guard/i.test(reason)) {
      routingBuckets.guardrail_flag += n;
    } else {
      routingBuckets.other += n;
    }
  }

  const statusBreakdown = database
    .prepare(
      `
      SELECT status, COUNT(*) AS requests
      FROM request_logs
      ${whereSql}
      GROUP BY status
      ORDER BY requests DESC
    `,
    )
    .all(...params)
    .map((row) => ({
      status: row.status,
      requests: Number(row.requests || 0),
    }));

  return {
    key: virtualKey || 'all',
    from: from || null,
    to: to || null,
    latency,
    by_provider: byProvider,
    by_requested_model: byRequestedModel,
    routing: {
      buckets: routingBuckets,
      top_reasons: routingRows.map((row) => ({
        reason: row.route_reason || '(none)',
        requests: Number(row.requests || 0),
      })),
    },
    by_status: statusBreakdown,
  };
}

/**
 * @param {{ virtualKey?: string | null, limit?: number }} opts
 */
export function getAdminLogs({ virtualKey = null, limit = 50 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
  if (virtualKey) {
    return getDb()
      .prepare(
        `SELECT * FROM request_logs WHERE virtual_key = ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(virtualKey, lim);
  }
  return getDb()
    .prepare('SELECT * FROM request_logs ORDER BY id DESC LIMIT ?')
    .all(lim);
}

function replyPreview(responseJson) {
  try {
    const body = JSON.parse(responseJson || '{}');
    const text =
      body?.choices?.[0]?.message?.content ||
      body?.choices?.[0]?.delta?.content ||
      '';
    const clean = String(text).replace(/\s+/g, ' ').trim();
    if (!clean) {
      return '';
    }
    return clean.length > 280 ? `${clean.slice(0, 280)}…` : clean;
  } catch {
    return '';
  }
}

/**
 * Cache rows for the admin UI. Embeddings stay in SQLite; only the size is returned.
 * @param {number} [limit]
 */
export function listAdminCacheEntries(limit = 200) {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
  return getDb()
    .prepare(
      `SELECT id, virtual_key, model, prompt_hash, prompt_text, hit_count,
              created_at, length(embedding) AS embedding_bytes, response_json
       FROM cache_entries
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(lim)
    .map((row) => ({
      id: row.id,
      virtual_key: row.virtual_key,
      model: row.model,
      prompt_hash: row.prompt_hash,
      prompt_text: row.prompt_text,
      hit_count: row.hit_count,
      created_at: row.created_at,
      embedding_dims: row.embedding_bytes
        ? Math.floor(Number(row.embedding_bytes) / 4)
        : 0,
      reply_preview: replyPreview(row.response_json),
    }));
}

/**
 * Recorded cache hits (one row per time an entry was served).
 * @param {number} [limit]
 */
export function listAdminCacheHits(limit = 200) {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
  return getDb()
    .prepare(
      `SELECT id, cache_entry_id, request_id, virtual_key, model, score,
              prompt_text, created_at
       FROM cache_hits
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(lim);
}

export function countRequestLogs() {
  return Number(
    getDb().prepare('SELECT COUNT(*) AS n FROM request_logs').get().n || 0,
  );
}

export function countCacheEntries() {
  return Number(
    getDb().prepare('SELECT COUNT(*) AS n FROM cache_entries').get().n || 0,
  );
}

export function countCacheHits() {
  return Number(
    getDb().prepare('SELECT COUNT(*) AS n FROM cache_hits').get().n || 0,
  );
}

function mapAdminKeyRow(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    model_allowlist: JSON.parse(row.model_allowlist || '[]'),
    verify_models: JSON.parse(row.verify_models || '[]'),
    cache_enabled: Boolean(row.cache_enabled),
  };
}

export function listAdminKeys() {
  return getDb()
    .prepare(
      `
      SELECT vk.id, vk.user_id, vk.virtual_key, vk.team, vk.monthly_budget_usd,
             vk.rpm_limit, vk.tpm_limit, vk.token_cap, vk.model_allowlist,
             vk.verify_models, vk.cache_enabled, vk.cache_similarity, vk.status,
             vk.created_at, u.name AS user_name, u.username AS username
      FROM virtual_keys vk
      LEFT JOIN users u ON u.id = vk.user_id
      ORDER BY vk.id
    `,
    )
    .all()
    .map(mapAdminKeyRow);
}

export function getAdminKeyById(id) {
  return mapAdminKeyRow(
    getDb()
      .prepare(
        `
      SELECT vk.id, vk.user_id, vk.virtual_key, vk.team, vk.monthly_budget_usd,
             vk.rpm_limit, vk.tpm_limit, vk.token_cap, vk.model_allowlist,
             vk.verify_models, vk.cache_enabled, vk.cache_similarity, vk.status,
             vk.created_at, u.name AS user_name, u.username AS username
      FROM virtual_keys vk
      LEFT JOIN users u ON u.id = vk.user_id
      WHERE vk.id = ?
    `,
      )
      .get(id),
  );
}

/** Pack seed keys must stay fixed for smoke/load demos. */
export function isSeedVirtualKey(virtualKey) {
  return config.seedTenants.some((tenant) => tenant.virtual_key === virtualKey);
}

function mintVirtualKeyString() {
  return `prism-sk-${randomBytes(9).toString('hex')}`;
}

/**
 * Create a virtual key (admin key-management API).
 * Always owned by a user. Prefer the user's team plan; optional planId override.
 */
export function createManagedKey(fields) {
  if (fields.userId == null || fields.userId === '') {
    throw new Error('user_id is required — every key must belong to a user');
  }
  const userId = Number(fields.userId);
  const user = getUserById(userId);
  if (!user) {
    throw new Error('user_id not found');
  }

  const team = String(fields.team || user.team || '').trim();
  if (!team) {
    throw new Error('team is required');
  }

  const existingActive = getDb()
    .prepare(
      `SELECT id FROM virtual_keys
       WHERE user_id = ? AND status = 'active'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(userId);
  if (existingActive) {
    throw new Error(
      'User already has an active key — disable or rotate it instead of creating another',
    );
  }

  let plan = null;
  if (fields.planId != null && fields.planId !== '') {
    plan = getPlanById(Number(fields.planId));
    if (!plan) {
      throw new Error('Plan not found');
    }
  } else {
    const teamRow = getDb()
      .prepare('SELECT plan_id FROM teams WHERE name = ?')
      .get(team);
    if (teamRow?.plan_id) {
      plan = getPlanById(teamRow.plan_id);
    }
  }

  const monthlyBudgetUsd =
    plan?.monthly_budget_usd ?? Number(fields.monthlyBudgetUsd);
  const rpmLimit = plan?.rpm_limit ?? Number(fields.rpmLimit);
  if (!Number.isFinite(monthlyBudgetUsd) || monthlyBudgetUsd < 0) {
    throw new Error('monthly_budget_usd must be >= 0 (or choose a plan)');
  }
  if (!Number.isFinite(rpmLimit) || rpmLimit < 1) {
    throw new Error('rpm_limit must be >= 1 (or choose a plan)');
  }

  const modelAllowlist = plan
    ? plan.model_allowlist
    : Array.isArray(fields.modelAllowlist)
      ? fields.modelAllowlist.map(String)
      : [];
  if (!modelAllowlist.length) {
    throw new Error('model_allowlist must include at least one model');
  }

  const verifyModels = plan
    ? plan.verify_models || []
    : Array.isArray(fields.verifyModels)
      ? fields.verifyModels.map(String)
      : [];
  const tpmLimit =
    plan?.tpm_limit ??
    (fields.tpmLimit == null || fields.tpmLimit === ''
      ? null
      : Number(fields.tpmLimit));
  const tokenCap =
    plan?.token_cap ??
    (fields.tokenCap == null || fields.tokenCap === ''
      ? null
      : Number(fields.tokenCap));
  const cacheEnabled = plan
    ? Boolean(plan.cache_enabled)
    : Boolean(fields.cacheEnabled);
  const cacheSimilarity = plan
    ? plan.cache_similarity
    : Number(fields.cacheSimilarity ?? 0.92);
  const guardrailInjection = plan
    ? plan.guardrail_injection || 'block'
    : String(fields.guardrailInjection || 'block');
  const guardrailPii = plan
    ? plan.guardrail_pii || 'flag'
    : String(fields.guardrailPii || 'flag');

  const virtualKey = mintVirtualKeyString();
  const result = getDb()
    .prepare(
      `INSERT INTO virtual_keys (
         virtual_key, team, user_id, monthly_budget_usd, rpm_limit, tpm_limit,
         token_cap, model_allowlist, verify_models, cache_enabled, cache_similarity,
         guardrail_injection, guardrail_pii, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    )
    .run(
      virtualKey,
      team,
      userId,
      monthlyBudgetUsd,
      Math.floor(rpmLimit),
      Number.isFinite(tpmLimit) ? Math.floor(tpmLimit) : null,
      Number.isFinite(tokenCap) ? Math.floor(tokenCap) : null,
      JSON.stringify(modelAllowlist),
      JSON.stringify(verifyModels),
      cacheEnabled ? 1 : 0,
      Number.isFinite(cacheSimilarity) ? cacheSimilarity : 0.92,
      guardrailInjection,
      guardrailPii,
    );
  return getAdminKeyById(Number(result.lastInsertRowid));
}

export function disableVirtualKey(id) {
  const key = getAdminKeyById(id);
  if (!key) {
    throw new Error('Key not found');
  }
  if (isSeedVirtualKey(key.virtual_key)) {
    throw new Error(
      'Pack seed keys cannot be disabled (smoke/load and demos depend on them)',
    );
  }
  if (key.status === 'disabled') {
    return key;
  }
  getDb()
    .prepare(`UPDATE virtual_keys SET status = 'disabled' WHERE id = ?`)
    .run(id);
  return getAdminKeyById(id);
}

export function enableVirtualKey(id) {
  const key = getAdminKeyById(id);
  if (!key) {
    throw new Error('Key not found');
  }
  if (isSeedVirtualKey(key.virtual_key)) {
    throw new Error('Pack seed keys are already managed by seed data');
  }
  getDb()
    .prepare(`UPDATE virtual_keys SET status = 'active' WHERE id = ?`)
    .run(id);
  return getAdminKeyById(id);
}

/**
 * Issue a new secret string for the same key row. Migrates usage + cache to the new string
 * so monthly budget continuity stays with the tenant. Old secret stops working immediately.
 */
export function rotateVirtualKey(id) {
  const key = getAdminKeyById(id);
  if (!key) {
    throw new Error('Key not found');
  }
  if (isSeedVirtualKey(key.virtual_key)) {
    throw new Error(
      'Pack seed keys cannot be rotated (smoke/load and demos depend on fixed strings)',
    );
  }
  if (key.status !== 'active') {
    throw new Error('Only active keys can be rotated; enable the key first');
  }

  const oldKey = key.virtual_key;
  const newKey = mintVirtualKeyString();

  return runTxn((database) => {
    database
      .prepare(`UPDATE virtual_keys SET virtual_key = ? WHERE id = ?`)
      .run(newKey, id);
    database
      .prepare(`UPDATE usage SET virtual_key = ? WHERE virtual_key = ?`)
      .run(newKey, oldKey);
    database
      .prepare(`UPDATE cache_entries SET virtual_key = ? WHERE virtual_key = ?`)
      .run(newKey, oldKey);
    database
      .prepare(`UPDATE cache_hits SET virtual_key = ? WHERE virtual_key = ?`)
      .run(newKey, oldKey);
    return {
      ...getAdminKeyById(id),
      previous_virtual_key: oldKey,
      rotated: true,
    };
  });
}

function runTxn(work) {
  const database = getDb();
  database.exec('BEGIN');
  try {
    const result = work(database);
    database.exec('COMMIT');
    return result;
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

function deleteKeyDependents(database, virtualKey) {
  database.prepare('DELETE FROM cache_hits WHERE virtual_key = ?').run(virtualKey);
  database.prepare('DELETE FROM cache_entries WHERE virtual_key = ?').run(virtualKey);
  database.prepare('DELETE FROM usage WHERE virtual_key = ?').run(virtualKey);
}

export function clearAdminTable(table) {
  const allowed = new Set([
    'request_logs',
    'cache_hits',
    'cache_entries',
    'usage',
    'chat_sessions',
    'virtual_keys',
    'users',
    'teams',
    'plans',
  ]);
  if (!allowed.has(table)) {
    throw new Error(`Table '${table}' cannot be cleared`);
  }
  return runTxn((database) => {
    if (table === 'cache_entries') {
      database.exec('DELETE FROM cache_hits');
      database.exec('DELETE FROM cache_entries');
    } else if (table === 'virtual_keys') {
      database.exec('DELETE FROM cache_hits');
      database.exec('DELETE FROM cache_entries');
      database.exec('DELETE FROM usage');
      database.exec('DELETE FROM virtual_keys');
    } else if (table === 'users') {
      database.exec('DELETE FROM conversation_messages');
      database.exec('DELETE FROM conversations');
      database.exec('DELETE FROM chat_sessions');
      database.exec('DELETE FROM cache_hits');
      database.exec('DELETE FROM cache_entries');
      database.exec('DELETE FROM usage');
      database.exec('DELETE FROM virtual_keys');
      database.exec('DELETE FROM users');
    } else if (table === 'teams') {
      const used = database.prepare('SELECT COUNT(*) AS n FROM users').get().n;
      if (used) {
        throw new Error('Remove users before deleting every team');
      }
      database.exec('DELETE FROM teams');
    } else if (table === 'plans') {
      const used = database
        .prepare('SELECT COUNT(*) AS n FROM teams WHERE plan_id IS NOT NULL')
        .get().n;
      if (used) {
        throw new Error('Detach or delete teams before clearing every plan');
      }
      database.exec('DELETE FROM plans');
    } else {
      database.exec(`DELETE FROM ${table}`);
    }
    return { cleared: table };
  });
}

export function deleteAdminRecord(table, id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId < 1) {
    throw new Error('Invalid record id');
  }
  return runTxn((database) => {
    if (table === 'cache_entries') {
      database.prepare('DELETE FROM cache_hits WHERE cache_entry_id = ?').run(numericId);
      database.prepare('DELETE FROM cache_entries WHERE id = ?').run(numericId);
    } else if (table === 'virtual_keys') {
      const key = database
        .prepare('SELECT virtual_key FROM virtual_keys WHERE id = ?')
        .get(numericId);
      if (key) {
        deleteKeyDependents(database, key.virtual_key);
      }
      database.prepare('DELETE FROM virtual_keys WHERE id = ?').run(numericId);
    } else if (table === 'users') {
      database.prepare('DELETE FROM chat_sessions WHERE user_id = ?').run(numericId);
      const convIds = database
        .prepare('SELECT id FROM conversations WHERE user_id = ?')
        .all(numericId)
        .map((row) => row.id);
      for (const convId of convIds) {
        database
          .prepare('DELETE FROM conversation_messages WHERE conversation_id = ?')
          .run(convId);
      }
      database.prepare('DELETE FROM conversations WHERE user_id = ?').run(numericId);
      const keys = database
        .prepare('SELECT virtual_key FROM virtual_keys WHERE user_id = ?')
        .all(numericId);
      for (const key of keys) {
        deleteKeyDependents(database, key.virtual_key);
      }
      database.prepare('DELETE FROM virtual_keys WHERE user_id = ?').run(numericId);
      database.prepare('DELETE FROM users WHERE id = ?').run(numericId);
    } else if (table === 'teams') {
      const team = database.prepare('SELECT name FROM teams WHERE id = ?').get(numericId);
      if (team) {
        const used = database
          .prepare('SELECT COUNT(*) AS n FROM users WHERE team = ?')
          .get(team.name).n;
        if (used) {
          throw new Error('Team still has users');
        }
      }
      database.prepare('DELETE FROM teams WHERE id = ?').run(numericId);
    } else if (table === 'plans') {
      const used = database
        .prepare('SELECT COUNT(*) AS n FROM teams WHERE plan_id = ?')
        .get(numericId).n;
      if (used) {
        throw new Error('Plan is still assigned to a team');
      }
      database.prepare('DELETE FROM plans WHERE id = ?').run(numericId);
    } else if (table === 'request_logs' || table === 'cache_hits' || table === 'usage') {
      database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(numericId);
    } else {
      throw new Error(`Table '${table}' cannot be edited`);
    }
    return { deleted: table, id: numericId };
  });
}

export function listPlans() {
  return getDb()
    .prepare('SELECT * FROM plans ORDER BY name')
    .all()
    .map(mapPlanRow);
}

export function getPlanById(id) {
  return mapPlanRow(
    getDb().prepare('SELECT * FROM plans WHERE id = ?').get(id),
  );
}

export function createPlan(fields) {
  const result = getDb()
    .prepare(
      `INSERT INTO plans (
         name, monthly_budget_usd, rpm_limit, tpm_limit, token_cap,
         model_allowlist, verify_models, cache_enabled, cache_similarity,
         guardrail_injection, guardrail_pii
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fields.name,
      fields.monthlyBudgetUsd,
      fields.rpmLimit,
      fields.tpmLimit,
      fields.tokenCap,
      JSON.stringify(fields.modelAllowlist),
      JSON.stringify(fields.verifyModels || []),
      fields.cacheEnabled ? 1 : 0,
      fields.cacheSimilarity,
      fields.guardrailInjection || 'block',
      fields.guardrailPii || 'flag',
    );
  return getPlanById(Number(result.lastInsertRowid));
}

export function updatePlan(id, fields) {
  const existing = getPlanById(id);
  if (!existing) {
    throw new Error('Plan not found');
  }
  return runTxn((database) => {
    database
      .prepare(
        `UPDATE plans SET
           name = ?,
           monthly_budget_usd = ?,
           rpm_limit = ?,
           tpm_limit = ?,
           token_cap = ?,
           model_allowlist = ?,
           verify_models = ?,
           cache_enabled = ?,
           cache_similarity = ?,
           guardrail_injection = ?,
           guardrail_pii = ?
         WHERE id = ?`,
      )
      .run(
        fields.name,
        fields.monthlyBudgetUsd,
        fields.rpmLimit,
        fields.tpmLimit,
        fields.tokenCap,
        JSON.stringify(fields.modelAllowlist),
        JSON.stringify(fields.verifyModels || []),
        fields.cacheEnabled ? 1 : 0,
        fields.cacheSimilarity,
        fields.guardrailInjection || 'block',
        fields.guardrailPii || 'flag',
        id,
      );

    const plan = mapPlanRow(
      database.prepare('SELECT * FROM plans WHERE id = ?').get(id),
    );
    const teams = database
      .prepare('SELECT name FROM teams WHERE plan_id = ?')
      .all(id);
    for (const team of teams) {
      const users = database
        .prepare('SELECT id FROM users WHERE team = ? AND status = ?')
        .all(team.name, 'active');
      for (const user of users) {
        applyPlanToUserKey(database, user.id, team.name, plan);
      }
    }
    return plan;
  });
}

export function listTeams() {
  return getDb()
    .prepare(
      `SELECT t.id, t.name, t.plan_id, t.created_at, p.name AS plan_name
       FROM teams t
       LEFT JOIN plans p ON p.id = t.plan_id
       ORDER BY t.name`,
    )
    .all();
}

export function createTeam({ name, planId }) {
  const clean = String(name || '').trim();
  if (!clean) {
    throw new Error('Team name is required');
  }
  const plan = getPlanById(planId);
  if (!plan) {
    throw new Error('Choose a plan for this team');
  }
  const result = getDb()
    .prepare('INSERT INTO teams (name, plan_id) VALUES (?, ?)')
    .run(clean, plan.id);
  return {
    id: Number(result.lastInsertRowid),
    name: clean,
    plan_id: plan.id,
    plan_name: plan.name,
  };
}

export function updateTeam(id, { name, planId }) {
  const team = getDb().prepare('SELECT * FROM teams WHERE id = ?').get(id);
  if (!team) {
    throw new Error('Team not found');
  }
  const clean = String(name || '').trim();
  if (!clean) {
    throw new Error('Team name is required');
  }
  const plan = getPlanById(planId);
  if (!plan) {
    throw new Error('Choose a plan for this team');
  }

  return runTxn((database) => {
    const oldName = team.name;
    database
      .prepare('UPDATE teams SET name = ?, plan_id = ? WHERE id = ?')
      .run(clean, plan.id, id);
    if (oldName !== clean) {
      database
        .prepare('UPDATE users SET team = ? WHERE team = ?')
        .run(clean, oldName);
      database
        .prepare('UPDATE virtual_keys SET team = ? WHERE team = ?')
        .run(clean, oldName);
    }
    const users = database
      .prepare('SELECT id FROM users WHERE team = ? AND status = ?')
      .all(clean, 'active');
    for (const user of users) {
      applyPlanToUserKey(database, user.id, clean, plan);
    }
    return {
      id,
      name: clean,
      plan_id: plan.id,
      plan_name: plan.name,
    };
  });
}

export function listAccessUsers() {
  return getDb()
    .prepare(
      `SELECT u.id, u.name, u.username, u.team, u.status, u.access_mode,
              CASE WHEN u.password_hash IS NULL OR u.password_hash = '' THEN 0 ELSE 1 END AS has_password,
              t.plan_id, p.name AS plan_name,
              vk.id AS key_id, vk.virtual_key, vk.status AS key_status,
              vk.monthly_budget_usd, vk.rpm_limit, vk.model_allowlist AS key_models
       FROM users u
       LEFT JOIN teams t ON t.name = u.team
       LEFT JOIN plans p ON p.id = t.plan_id
       LEFT JOIN virtual_keys vk ON vk.id = (
         SELECT id FROM virtual_keys
         WHERE user_id = u.id
         ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, id DESC
         LIMIT 1
       )
       ORDER BY u.id`,
    )
    .all()
    .map((row) => ({
      ...row,
      access_mode: normalizeAccessMode(row.access_mode),
      has_password: Boolean(row.has_password),
      key_models: row.key_models ? JSON.parse(row.key_models) : [],
    }));
}

export function createAccessUser({
  name,
  username,
  passwordHash,
  team,
  accessMode = 'both',
}) {
  const mode = normalizeAccessMode(accessMode);
  if (accessModeAllowsChat(mode) && !passwordHash) {
    throw new Error('Password is required for Chat or Both access');
  }
  const teamRow = getDb().prepare('SELECT * FROM teams WHERE name = ?').get(team);
  if (!teamRow) {
    throw new Error('Create the team before adding the user');
  }
  const plan = getPlanById(teamRow.plan_id);
  if (!plan) {
    throw new Error('Assign a plan to this team before adding users');
  }

  return runTxn((database) => {
    const result = database
      .prepare(
        `INSERT INTO users (name, team, status, username, password_hash, access_mode)
         VALUES (?, ?, 'active', ?, ?, ?)`,
      )
      .run(name, team, username, passwordHash || null, mode);
    const userId = Number(result.lastInsertRowid);
    applyPlanToUserKey(database, userId, team, plan);
    return {
      id: userId,
      name,
      username,
      team,
      access_mode: mode,
      plan_id: plan.id,
      plan_name: plan.name,
      has_password: Boolean(passwordHash),
    };
  });
}

/**
 * Seeded chat login for demos (idempotent). Team research → fast/smart/auto.
 * Password is public demo only — not for production.
 */
function ensureDemoChatUser() {
  const database = getDb();
  const existing = database
    .prepare('SELECT id FROM users WHERE username = ?')
    .get('demo');
  if (existing) {
    return;
  }

  const teamRow = database.prepare('SELECT * FROM teams WHERE name = ?').get('research');
  if (!teamRow?.plan_id) {
    return;
  }

  const created = createAccessUser({
    name: 'Demo chat user',
    username: 'demo',
    passwordHash: hashPassword('demo123'),
    team: 'research',
    accessMode: 'both',
  });

  // Cap so the chat UI usage bar / warnings are visible in demos.
  const demoTokenCap = 50_000;
  database
    .prepare('UPDATE users SET token_cap = ? WHERE id = ?')
    .run(demoTokenCap, created.id);
  database
    .prepare(
      `UPDATE virtual_keys SET token_cap = ?
       WHERE user_id = ? AND status = 'active'`,
    )
    .run(demoTokenCap, created.id);
}

export function updateAccessUser(
  id,
  { name, username, passwordHash, team, accessMode },
) {
  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) {
    throw new Error('User not found');
  }
  const mode = normalizeAccessMode(
    accessMode == null ? user.access_mode : accessMode,
  );
  const teamRow = getDb().prepare('SELECT * FROM teams WHERE name = ?').get(team);
  if (!teamRow) {
    throw new Error('Team not found');
  }
  const plan = getPlanById(teamRow.plan_id);
  if (!plan) {
    throw new Error('Assign a plan to this team before updating the user');
  }

  const willHavePassword = Boolean(
    passwordHash || (user.password_hash && !passwordHash),
  );
  // passwordHash null means keep existing; empty string means clear — we only set when provided
  const keepsPassword = Boolean(user.password_hash) && passwordHash == null;
  const hasPasswordAfter = Boolean(passwordHash) || keepsPassword;
  if (accessModeAllowsChat(mode) && !hasPasswordAfter) {
    throw new Error('Password is required for Chat or Both access');
  }

  return runTxn((database) => {
    if (passwordHash) {
      database
        .prepare(
          `UPDATE users SET name = ?, username = ?, team = ?, password_hash = ?, access_mode = ?
           WHERE id = ?`,
        )
        .run(name, username, team, passwordHash, mode, id);
    } else {
      database
        .prepare(
          `UPDATE users SET name = ?, username = ?, team = ?, access_mode = ?
           WHERE id = ?`,
        )
        .run(name, username, team, mode, id);
    }
    applyPlanToUserKey(database, id, team, plan);
    return {
      id,
      name,
      username,
      team,
      access_mode: mode,
      plan_id: plan.id,
      plan_name: plan.name,
      has_password: willHavePassword || hasPasswordAfter,
    };
  });
}

export function findActiveKeyForUser(userId) {
  return getDb()
    .prepare(
      `SELECT virtual_key, model_allowlist, status
       FROM virtual_keys
       WHERE user_id = ? AND status = 'active'
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(userId);
}

export function findUserByUsername(username) {
  return getDb()
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username);
}

export function createChatSession(userId) {
  const token = randomBytes(24).toString('hex');
  getDb()
    .prepare('INSERT INTO chat_sessions (token, user_id) VALUES (?, ?)')
    .run(token, userId);
  return token;
}

/**
 * Active chat session plus the user's newest virtual key.
 * @param {string} token
 */
export function resolveChatSession(token) {
  return getDb()
    .prepare(
      `SELECT u.id AS user_id, u.name, u.username, u.team, u.status AS user_status,
              u.token_cap AS user_token_cap, u.access_mode,
              vk.virtual_key, vk.model_allowlist, vk.verify_models,
              vk.token_cap AS key_token_cap,
              vk.status AS key_status
       FROM chat_sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN virtual_keys vk ON vk.id = (
         SELECT id FROM virtual_keys
         WHERE user_id = u.id AND status = 'active'
         ORDER BY id DESC
         LIMIT 1
       )
       WHERE s.token = ?`,
    )
    .get(token);
}

function titleFromPrompt(text) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) {
    return 'New chat';
  }
  return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean;
}

export function listConversations(userId) {
  return getDb()
    .prepare(
      `SELECT id, title, created_at, updated_at
       FROM conversations
       WHERE user_id = ?
       ORDER BY datetime(updated_at) DESC, id DESC`,
    )
    .all(userId);
}

export function createConversation(userId, title = 'New chat') {
  const result = getDb()
    .prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?)')
    .run(userId, String(title || 'New chat').trim() || 'New chat');
  return getConversation(Number(result.lastInsertRowid), userId);
}

export function getConversation(id, userId) {
  const conversation = getDb()
    .prepare(
      `SELECT id, title, created_at, updated_at
       FROM conversations
       WHERE id = ? AND user_id = ?`,
    )
    .get(id, userId);
  if (!conversation) {
    return null;
  }
  const messages = getDb()
    .prepare(
      `SELECT id, role, content, created_at, verified
       FROM conversation_messages
       WHERE conversation_id = ?
       ORDER BY id ASC`,
    )
    .all(conversation.id);
  return { ...conversation, messages };
}

export function deleteConversation(id, userId) {
  return runTxn((database) => {
    const owned = database
      .prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
      .get(id, userId);
    if (!owned) {
      return false;
    }
    database
      .prepare('DELETE FROM conversation_messages WHERE conversation_id = ?')
      .run(id);
    database.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    return true;
  });
}

export function renameConversation(id, userId, title) {
  const clean = String(title || '').trim();
  if (!clean) {
    throw new Error('Title is required');
  }
  const result = getDb()
    .prepare(
      `UPDATE conversations
       SET title = ?, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`,
    )
    .run(clean, id, userId);
  if (!result.changes) {
    return null;
  }
  return getConversation(id, userId);
}

/**
 * Append turns after a successful chat reply. Titles empty threads from the first user line.
 * @param {number} conversationId
 * @param {number} userId
 * @param {{ role: string, content: string }[]} turns
 */
export function appendConversationMessages(conversationId, userId, turns) {
  return runTxn((database) => {
    const owned = database
      .prepare('SELECT id, title FROM conversations WHERE id = ? AND user_id = ?')
      .get(conversationId, userId);
    if (!owned) {
      throw new Error('Conversation not found');
    }
    const insert = database.prepare(
      `INSERT INTO conversation_messages (conversation_id, role, content, verified)
       VALUES (?, ?, ?, ?)`,
    );
    for (const turn of turns) {
      const role = turn.role === 'assistant' ? 'assistant' : 'user';
      const content = String(turn.content || '');
      if (!content) {
        continue;
      }
      insert.run(conversationId, role, content, turn.verified ? 1 : 0);
    }
    const count = database
      .prepare(
        'SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ?',
      )
      .get(conversationId).n;
    const firstUser = turns.find((t) => t.role === 'user' && t.content);
    if (count <= turns.length && owned.title === 'New chat' && firstUser) {
      database
        .prepare(
          `UPDATE conversations
           SET title = ?, updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(titleFromPrompt(firstUser.content), conversationId);
    } else {
      database
        .prepare(
          `UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`,
        )
        .run(conversationId);
    }
    return getConversation(conversationId, userId);
  });
}
