/**
 * Routing eval over data/routing_eval.jsonl (classification only).
 * Does not pass expected_tier into the router.
 *
 * Usage: npm run eval:routing
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyWithLocalRules,
  lengthBaselineTier,
} from '../src/router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EVAL_PATH = path.join(ROOT, 'data', 'routing_eval.jsonl');

const lines = fs
  .readFileSync(EVAL_PATH, 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean);

const cases = [];
let correct = 0;
let baselineCorrect = 0;

for (const line of lines) {
  const row = JSON.parse(line);
  // Answer key used ONLY here for scoring — never passed into classify*
  const expected = row.expected_tier;
  const local = classifyWithLocalRules(row.prompt);
  const baseline = lengthBaselineTier(row.prompt);
  const actual = local.tier;
  const ok = actual === expected;
  if (ok) correct += 1;
  if (baseline === expected) baselineCorrect += 1;

  cases.push({
    id: row.id,
    expected,
    actual,
    reason: local.reason,
    note: row.note,
    correct: ok,
    baseline,
  });
}

const total = cases.length;
const report = {
  total,
  correct,
  accuracy: total ? Number((correct / total).toFixed(4)) : 0,
  length_baseline_correct: baselineCorrect,
  length_baseline_accuracy: total
    ? Number((baselineCorrect / total).toFixed(4))
    : 0,
  method: 'local_rules_first (OpenRouter classifier only when confidence=low and key set)',
  cases,
};

console.log(JSON.stringify(report, null, 2));

const outPath = path.join(ROOT, 'test', 'routing_eval_report.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.error(
  `\naccuracy=${report.accuracy} baseline=${report.length_baseline_accuracy} wrote ${outPath}`,
);

if (report.accuracy <= report.length_baseline_accuracy) {
  console.error('FAIL: did not beat length baseline');
  process.exit(1);
}
if (report.accuracy <= 0.6) {
  console.error('FAIL: accuracy <= 0.60');
  process.exit(1);
}
