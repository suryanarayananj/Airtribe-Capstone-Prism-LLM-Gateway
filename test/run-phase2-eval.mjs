/**
 * Phase 2 integration checks against a running gateway + mock.
 * Usage: node test/run-phase2-eval.mjs
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.PRISM_URL || 'http://127.0.0.1:8080';
const SEARCH = 'prism-sk-search-1a2b3c';
const FREE = 'prism-sk-free-7g8h9i';
const BUDGET = 'prism-sk-budget-demo-0j1k2l';

async function chat(key, body) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, headers: res.headers, json };
}

function yearMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
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

// P2-1 bad key
{
  const r = await chat('not-a-real-key', {
    model: 'fast',
    messages: [{ role: 'user', content: 'hi' }],
  });
  if (r.status === 401 && r.json?.error?.type === 'authentication_error') {
    pass('P2-1');
  } else {
    fail('P2-1', JSON.stringify(r));
  }
}

// P2-2 empty messages
{
  const r = await chat(SEARCH, { model: 'fast', messages: [] });
  if (r.status === 400 && r.json?.error?.type === 'invalid_request_error') {
    pass('P2-2');
  } else {
    fail('P2-2', JSON.stringify(r));
  }
}

// P2-3 unknown model
{
  const r = await chat(SEARCH, {
    model: 'no-such-model',
    messages: [{ role: 'user', content: 'hi' }],
  });
  if (r.status === 404 && r.json?.error?.type === 'not_found_error') {
    pass('P2-3');
  } else {
    fail('P2-3', JSON.stringify(r));
  }
}

// P2-4 allowlist (search key cannot use smart)
{
  const r = await chat(SEARCH, {
    model: 'smart',
    messages: [{ role: 'user', content: 'hi' }],
  });
  if (r.status === 403 && r.json?.error?.type === 'model_not_allowed') {
    pass('P2-4');
  } else {
    fail('P2-4', JSON.stringify(r));
  }
}

// P2-5 RPM on free key (limit 10)
{
  let got429 = false;
  for (let i = 0; i < 12; i += 1) {
    const r = await chat(FREE, {
      model: 'fast',
      messages: [{ role: 'user', content: `rpm-test-${Date.now()}-${i}` }],
    });
    if (r.status === 429 && r.json?.error?.type === 'rate_limit_exceeded') {
      got429 = true;
      break;
    }
  }
  if (got429) pass('P2-5');
  else fail('P2-5', 'never saw 429');
}

// P2-6 budget demo — long prompt so cost exceeds tiny $0.00001 budget (pack intent)
{
  const longPrompt =
    'Explain message queues in detail. '.repeat(40) + `id=${Date.now()}`;
  const r1 = await chat(BUDGET, {
    model: 'fast',
    messages: [{ role: 'user', content: longPrompt }],
  });
  const r2 = await chat(BUDGET, {
    model: 'fast',
    messages: [{ role: 'user', content: longPrompt + '-b' }],
  });
  const secondIs402 =
    r2.status === 402 && r2.json?.error?.type === 'budget_exceeded';
  const firstAlready =
    r1.status === 402 && r1.json?.error?.type === 'budget_exceeded';
  if ((r1.status === 200 && secondIs402) || firstAlready) {
    pass(
      'P2-6',
      firstAlready ? 'already exhausted' : `first=${r1.status} second=402`,
    );
  } else {
    fail('P2-6', JSON.stringify({ r1Status: r1.status, r2Status: r2.status, r2Type: r2.json?.error?.type, r1Cost: r1.headers.get?.('x-prism-cost-usd') }));
  }
}

// P2-7 cost header math
{
  const r = await chat(SEARCH, {
    model: 'fast',
    messages: [{ role: 'user', content: `cost-check-${Date.now()}` }],
  });
  const costHeader = r.headers.get('x-prism-cost-usd');
  const usage = r.json?.usage;
  const prices = {
    input_per_1m: 0.15,
    output_per_1m: 0.6,
  };
  const expected =
    ((usage?.prompt_tokens || 0) * prices.input_per_1m +
      (usage?.completion_tokens || 0) * prices.output_per_1m) /
    1_000_000;
  const headerNum = Number(costHeader);
  const ok =
    r.status === 200 &&
    costHeader != null &&
    Math.abs(headerNum - expected) < 1e-12;
  if (ok) pass('P2-7', `cost=${costHeader}`);
  else fail('P2-7', JSON.stringify({ costHeader, expected, usage, status: r.status }));
}

// P2-8 persistence
{
  const db = new DatabaseSync(path.join(ROOT, 'data', 'prism.db'));
  const ym = yearMonth();
  const usage = db
    .prepare(
      'SELECT * FROM usage WHERE virtual_key = ? AND year_month = ?',
    )
    .get(SEARCH, ym);
  const log = db
    .prepare(
      'SELECT * FROM request_logs WHERE virtual_key = ? ORDER BY id DESC LIMIT 1',
    )
    .get(SEARCH);
  db.close();
  if (usage && usage.requests > 0 && log && log.status) {
    pass(
      'P2-8',
      `usage.requests=${usage.requests} log.status=${log.status}`,
    );
  } else {
    fail('P2-8', JSON.stringify({ usage, log }));
  }
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\nPhase 2 integration: ${results.length - failed.length}/${results.length} passed`,
);
if (failed.length) {
  process.exit(1);
}
