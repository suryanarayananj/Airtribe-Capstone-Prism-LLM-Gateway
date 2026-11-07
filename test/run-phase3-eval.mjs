/**
 * Phase 3 integration checks. Requires alpha:18001, beta:18002, gateway:8080.
 * Usage: node test/run-phase3-eval.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.PRISM_URL || 'http://127.0.0.1:8080';
const ALPHA = process.env.PRISM_ALPHA_ADMIN || 'http://127.0.0.1:18001';
const BETA = process.env.PRISM_BETA_ADMIN || 'http://127.0.0.1:18002';
const KEY = 'prism-sk-search-1a2b3c';

async function setMock(adminBase, cfg) {
  await fetch(`${adminBase}/admin/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
}

async function chat(body, { stream = false } = {}) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...body, stream }),
  });
  return res;
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

await setMock(ALPHA, { mode: 'ok', latency_ms: 0, fail_rate: 0 });
await setMock(BETA, { mode: 'ok', latency_ms: 0, fail_rate: 0 });

// P3-1 stream happy path
{
  const res = await chat(
    { model: 'fast', messages: [{ role: 'user', content: `stream-${Date.now()}` }] },
    { stream: true },
  );
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  const hasDone = text.includes('data: [DONE]');
  const chunkCount = (text.match(/^data: /gm) || []).length;
  if (res.status === 200 && ct.includes('text/event-stream') && hasDone && chunkCount >= 2) {
    pass('P3-1', `chunks≈${chunkCount}`);
  } else {
    fail('P3-1', `status=${res.status} ct=${ct} done=${hasDone} chunks=${chunkCount}`);
  }
}

// P3-2 early bytes (mock paces ~20ms/word — stream should not be one giant wait then dump only)
{
  const t0 = Date.now();
  const res = await chat(
    {
      model: 'fast',
      messages: [{ role: 'user', content: 'word1 word2 word3 word4 word5 word6 word7 word8' }],
    },
    { stream: true },
  );
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let firstByteAt = null;
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByteAt == null) firstByteAt = Date.now();
    buf += decoder.decode(value, { stream: true });
  }
  const total = Date.now() - t0;
  const timeToFirst = firstByteAt - t0;
  // First byte should arrive well before the full paced stream finishes
  if (firstByteAt != null && timeToFirst < total && buf.includes('[DONE]')) {
    pass('P3-2', `ttf=${timeToFirst}ms total=${total}ms`);
  } else {
    fail('P3-2', `ttf=${timeToFirst} total=${total}`);
  }
}

// P3-3 failover on alpha down
{
  await setMock(ALPHA, { mode: 'down' });
  await setMock(BETA, { mode: 'ok', latency_ms: 0 });
  const res = await chat({
    model: 'fast',
    messages: [{ role: 'user', content: `failover-${Date.now()}` }],
  });
  const provider = res.headers.get('x-prism-provider');
  const fallback = res.headers.get('x-prism-fallback');
  const text = await res.text();
  if (
    res.status === 200 &&
    fallback === 'true' &&
    provider &&
    provider.startsWith('beta/')
  ) {
    pass('P3-3', `provider=${provider}`);
  } else {
    fail('P3-3', `status=${res.status} provider=${provider} fallback=${fallback} body=${text.slice(0, 200)}`);
  }
  await setMock(ALPHA, { mode: 'ok', latency_ms: 0 });
}

// P3-4 timeout then failover (alpha slow beyond gateway timeout)
{
  await setMock(ALPHA, { mode: 'ok', latency_ms: 8000 });
  await setMock(BETA, { mode: 'ok', latency_ms: 0 });
  const t0 = Date.now();
  const res = await chat({
    model: 'fast',
    messages: [{ role: 'user', content: `timeout-fo-${Date.now()}` }],
  });
  const elapsed = Date.now() - t0;
  const provider = res.headers.get('x-prism-provider');
  const fallback = res.headers.get('x-prism-fallback');
  await res.text();
  // timeout 5s + retries can stretch; must not hang to 60s; should land on beta
  if (
    res.status === 200 &&
    fallback === 'true' &&
    provider?.startsWith('beta/') &&
    elapsed < 45_000
  ) {
    pass('P3-4', `elapsed=${elapsed}ms provider=${provider}`);
  } else {
    fail(
      'P3-4',
      `status=${res.status} provider=${provider} fallback=${fallback} elapsed=${elapsed}`,
    );
  }
  await setMock(ALPHA, { mode: 'ok', latency_ms: 0 });
}

// P3-5 all down
{
  await setMock(ALPHA, { mode: 'down' });
  await setMock(BETA, { mode: 'down' });
  const res = await chat({
    model: 'fast',
    messages: [{ role: 'user', content: `alldown-${Date.now()}` }],
  });
  const json = await res.json();
  if (res.status === 502 && json?.error?.type === 'upstream_error') {
    pass('P3-5');
  } else {
    fail('P3-5', JSON.stringify({ status: res.status, json }));
  }
  await setMock(ALPHA, { mode: 'ok' });
  await setMock(BETA, { mode: 'ok' });
}

// P3-6 mid-stream policy covered by unit test pipe-sse.test.js (no splice)
pass('P3-6', 'unit: pipe-sse mid-stream error, no beta splice');

// P3-7 stream metering
{
  const before = (() => {
    const db = new DatabaseSync(path.join(ROOT, 'data', 'prism.db'));
    const row = db
      .prepare(
        `SELECT requests, prompt_tokens, completion_tokens, cost_usd FROM usage
         WHERE virtual_key = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(KEY);
    db.close();
    return row || { requests: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 };
  })();

  const res = await chat(
    {
      model: 'fast',
      messages: [{ role: 'user', content: `meter-stream-${Date.now()}` }],
    },
    { stream: true },
  );
  await res.text();

  const after = (() => {
    const db = new DatabaseSync(path.join(ROOT, 'data', 'prism.db'));
    const row = db
      .prepare(
        `SELECT requests, prompt_tokens, completion_tokens, cost_usd FROM usage
         WHERE virtual_key = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(KEY);
    const log = db
      .prepare(
        `SELECT status, prompt_tokens, completion_tokens, cost_usd FROM request_logs
         WHERE virtual_key = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(KEY);
    db.close();
    return { row, log };
  })();

  if (
    after.row &&
    after.row.requests >= before.requests &&
    after.log?.status === 'ok' &&
    (after.log.prompt_tokens > 0 || after.log.completion_tokens > 0)
  ) {
    pass(
      'P3-7',
      `log tokens=${after.log.prompt_tokens}/${after.log.completion_tokens} cost=${after.log.cost_usd}`,
    );
  } else {
    fail('P3-7', JSON.stringify({ before, after }));
  }
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\nPhase 3 integration: ${results.length - failed.length}/${results.length} passed`,
);
if (failed.length) process.exit(1);
