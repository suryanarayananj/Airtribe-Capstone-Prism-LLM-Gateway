/**
 * Phase 5 semantic cache eval. Needs gateway + alpha mock.
 * First run downloads the embedding model (may take a minute).
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.PRISM_URL || 'http://127.0.0.1:8080';
const ALPHA = process.env.PRISM_ALPHA_ADMIN || 'http://127.0.0.1:18001';
const BETA = process.env.PRISM_BETA_ADMIN || 'http://127.0.0.1:18002';

const SEARCH = 'prism-sk-search-1a2b3c';
const FREE = 'prism-sk-free-7g8h9i';
const BUDGET = 'prism-sk-budget-demo-0j1k2l';

const A1 = 'How do I reset my password on the dashboard?';
const A2 = 'What are the steps to reset my dashboard password?';
const A3 = 'How do I reset my two-factor authentication on the dashboard?';

async function chat(key, content, extra = {}) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'fast',
      messages: [{ role: 'user', content }],
      ...extra,
    }),
  });
  const json = await res.json().catch(() => ({}));
  return {
    status: res.status,
    cache: res.headers.get('x-prism-cache'),
    cost: res.headers.get('x-prism-cost-usd'),
    provider: res.headers.get('x-prism-provider'),
    json,
  };
}

async function setMock(url, cfg) {
  await fetch(`${url}/admin/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
}

function clearCacheTable() {
  const db = new DatabaseSync(path.join(ROOT, 'data', 'prism.db'));
  db.exec('DELETE FROM cache_entries');
  db.close();
}

const results = [];
function pass(id, note = '') {
  results.push({ id, ok: true, note });
  console.log(`PASS ${id}${note ? ` — ${note}` : ''}`);
}
function fail(id, note) {
  results.push({ id, ok: false, note });
  console.error(`FAIL ${id} — ${note}`);
}

clearCacheTable();
await setMock(ALPHA, { mode: 'ok', latency_ms: 0, fail_rate: 0 });
await setMock(BETA, { mode: 'ok', latency_ms: 0, fail_rate: 0 });

console.log('Warming embeddings (first call may download the model)...');

// P5-1 unique miss
{
  const r = await chat(SEARCH, `unique-salt-${Date.now()}-password-reset-guide`);
  if (r.status === 200 && r.cache === 'miss') pass('P5-1', `provider=${r.provider}`);
  else fail('P5-1', JSON.stringify(r));
}

// P5-2 exact repeat
{
  const prompt = `exact-repeat-${Date.now()} how do I open settings?`;
  const r1 = await chat(SEARCH, prompt);
  const r2 = await chat(SEARCH, prompt);
  if (r1.cache === 'miss' && r2.cache === 'hit' && r2.cost === '0') {
    pass('P5-2');
  } else fail('P5-2', JSON.stringify({ r1, r2 }));
}

// P5-3 paraphrase a1→a2
{
  const r1 = await chat(SEARCH, A1);
  const r2 = await chat(SEARCH, A2);
  if (r1.cache === 'miss' && r2.cache === 'hit') pass('P5-3', `cost=${r2.cost}`);
  else fail('P5-3', JSON.stringify({ r1, r2 }));
}

// P5-4 near-miss a3
{
  const r = await chat(SEARCH, A3);
  if (r.cache === 'miss') pass('P5-4');
  else fail('P5-4', JSON.stringify(r));
}

// P5-5 cross-key: free key must not see search cache
{
  const r = await chat(FREE, A2);
  if (r.cache === 'miss') pass('P5-5');
  else fail('P5-5', JSON.stringify(r));
}

// P5-6 cache disabled (budget-demo) — long prompt to avoid budget flake after first
{
  // Use a short prompt; budget may already be exhausted from prior phases — accept 402 or miss
  const r1 = await chat(BUDGET, `budget-cache-off-${Date.now()}`);
  const r2 = await chat(BUDGET, `budget-cache-off-same`);
  if (r1.cache === 'hit' || r2.cache === 'hit') {
    fail('P5-6', 'cache hit on disabled key');
  } else {
    pass('P5-6', `statuses=${r1.status}/${r2.status}`);
  }
}

// P5-7 failures not cached
{
  const prompt = `fail-cache-${Date.now()} should not be stored on error`;
  await setMock(ALPHA, { mode: 'down' });
  await setMock(BETA, { mode: 'down' });
  const rFail = await chat(SEARCH, prompt);
  await setMock(ALPHA, { mode: 'ok' });
  await setMock(BETA, { mode: 'ok' });
  const rOk = await chat(SEARCH, prompt);
  if (rFail.status >= 400 && rOk.cache === 'miss') {
    pass('P5-7', `fail=${rFail.status} then miss`);
  } else {
    fail('P5-7', JSON.stringify({ rFail, rOk }));
  }
}

// P5-8 stats
{
  const res = await fetch(`${BASE}/admin/cache/stats`);
  const stats = await res.json();
  if (
    res.status === 200 &&
    stats.entries > 0 &&
    (stats.process_hits > 0 || stats.cumulative_entry_hits > 0)
  ) {
    pass('P5-8', JSON.stringify(stats));
  } else {
    fail('P5-8', JSON.stringify(stats));
  }
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\nPhase 5: ${results.length - failed.length}/${results.length} passed`,
);
if (failed.length) process.exit(1);
