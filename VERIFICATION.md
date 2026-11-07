# Prism — Verification Report

**Upstream:** pack mocks (`PRISM_UPSTREAM=mock`) on `127.0.0.1:18001` (alpha) and `18002` (beta)  
**Gateway:** `http://localhost:8080`  
**Raw captures:** outputs below; routing JSON at `test/routing_eval_report.json` when re-run

---

## Summary

| Check | Result |
|---|---|
| Smoke (`scripts/smoke_test.py`) | **17 passed, 1 warning, 0 failed** |
| Load over-admission | **OK** — 10 accepted ≤ RPM 10 |
| Load accounting vs usage API | **Exact match** on burst delta |
| Routing eval | **20/20 (accuracy 1.0)** vs length baseline **0.4** |
| Latency (load burst, accepted) | avg **2367 ms**, p95 **2501 ms** |

---

## 1. Smoke test

**Command**

```powershell
py -3 scripts\smoke_test.py --url http://localhost:8080 --key prism-sk-search-1a2b3c --model fast
```

**Output**

```text
[1] Non-streaming completion + header contract
  PASS  returns 200  (got 200)
  PASS  body has choices and usage
  PASS  header x-prism-provider present  (alpha/alpha-small)
  PASS  header x-prism-cache present  (miss)
  PASS  header x-prism-cost-usd present  (0.0000123)
  PASS  first request is a cache miss  (miss)

[2] Streaming
  PASS  returns 200  (got 200)
  PASS  content-type is text/event-stream  (text/event-stream)
  PASS  received multiple SSE chunks  (22 data lines)
  PASS  stream ends with [DONE]

[3] Auth
  PASS  invalid key rejected with 401/403  (got 401)

[4] Unknown model
  PASS  unknown model rejected with 4xx  (got 404)
  PASS  error body explains the problem  ({'error': {'message': "Unknown model or alias 'no-such-model-xyz'", 'type': 'not)

[5] Semantic cache: exact repeat
  PASS  identical repeat is a cache hit  (hit)

[6] Semantic cache: paraphrases (each pair soft; at least one pair must hit)
  PASS  pair A paraphrase is a cache hit  (hit)
  WARN  pair B paraphrase is a cache hit  (miss)
  PASS  matching is semantic, not exact-only (at least one pair hit)

[7] Semantic cache: unrelated prompt
  PASS  unrelated prompt is a cache miss  (miss)

==================================================
  17 passed, 1 warnings, 0 failed
```

**WARN note:** Pack smoke treats each paraphrase pair as soft; the suite still **PASS**es when ≥1 pair hits. Pair A (message-queue paraphrase) hit at search threshold **0.92** with MiniLM; pair B missed (below threshold). Unrelated prompt correctly missed.

**Cache design under test**

| Item | Value |
|---|---|
| Embedding | `Xenova/all-MiniLM-L6-v2` (local) |
| Scope | Per virtual key |
| Search key threshold | 0.92 |
| Exact repeat | hit |
| Near-miss / unrelated | miss |

---

## 2. Load test

**Command**

```powershell
py -3 scripts\load_test.py --url http://localhost:8080 --key prism-sk-free-7g8h9i --model fast --requests 30 --concurrency 10 --rpm-limit 10
```

**Output**

```text
Bursting 30 requests at concurrency 10 ...

Burst finished in 6.7s
  accepted (200):      10
  rate limited (429):  20
  latency avg/p95 ms:  2367 / 2501

Client-side accounting totals - compare with your usage API for this key:
  accepted requests:   10
  prompt tokens:       48
  completion tokens:   108
  sum of cost headers: 0.000072 USD (10 of 10 had a numeric header)

Over-admission check OK: 10 accepted <= limit 10.
```

### Over-admission

| Metric | Value |
|---|---|
| Configured RPM (`prism-sk-free-7g8h9i`) | 10 |
| Concurrent burst | 30 requests / concurrency 10 |
| Accepted (200) | **10** |
| Rejected (429) | **20** |
| Verdict | **PASS** — no over-admission |

Limiter uses a synchronous check-and-consume critical section (`src/limiter.js`) so concurrent bursts cannot race past the ceiling.

### Accounting totals (reconcile)

Usage API before/after the burst (`GET /admin/usage?key=prism-sk-free-7g8h9i` with admin bearer):

| Source | Requests | Prompt tokens | Completion tokens | Cost USD |
|---|---|---|---|---|
| Load-test client (headers) | 10 | 48 | 108 | 0.000072 |
| Usage API **delta** (after − before) | 10 | 48 | 108 | 0.000072 |
| Usage `log_window` for burst | 10 | 48 | 108 | 0.000072 |

**Verdict:** exact reconcile. The November usage row moved by the same 10 requests, 48 / 108 tokens, and $0.000072.

### Latency summary

| Metric | Value | Method |
|---|---|---|
| Client avg (accepted) | **2367 ms** | `load_test.py` wall time per accepted request |
| Client p95 (accepted) | **2501 ms** | same |
| Burst wall clock | 6.7 s | 30 requests, concurrency 10 |

**Interpretation:** figures are **end-to-end client→gateway→mock** latency (includes mock generation). Gateway overhead alone is not instrumented separately; for this capstone the pack accepts coarse client-observed latency from the load script. Under mock upstream, typical accepted responses were ~2.5 s; rate-limited calls fail fast with 429 and are excluded from the avg/p95 above.

---

## 3. Routing eval

**Command**

```powershell
npm run eval:routing
```

**Aggregate**

| Metric | Value |
|---|---|
| Cases | 20 |
| Correct | **20** |
| Accuracy | **1.0 (100%)** |
| Length-only baseline correct | 8 |
| Length baseline accuracy | **0.4 (40%)** |
| Method | `local_rules_first` (OpenRouter classifier only when confidence=low and key set) |

This run used **local rules only** (no OpenRouter classifier needed). Labels in `data/routing_eval.jsonl` are never read at classification time.

### Per-case results

| ID | Expected | Actual | Correct | Baseline | Reason (abbrev.) | Note |
|---|---|---|---|---|---|---|
| route_001 | fast | fast | ✓ | fast | simple fact | short, easy fact |
| route_002 | fast | fast | ✓ | fast | unit conversion | short, easy conversion |
| route_003 | fast | fast | ✓ | fast | trivial writing | short, easy writing |
| route_004 | fast | fast | ✓ | fast | simple fact | short, easy definition |
| route_005 | fast | fast | ✓ | fast | translation | short, easy translation |
| route_006 | fast | fast | ✓ | smart | roster lookup | trap: long, trivial |
| route_007 | fast | fast | ✓ | smart | log field extraction | trap: long, trivial |
| route_008 | fast | fast | ✓ | fast | simple extraction | short, easy extraction |
| route_009 | fast | fast | ✓ | fast | simple arithmetic | short, easy arithmetic |
| route_010 | fast | fast | ✓ | fast | polite rewrite | trap: longer, trivial rewrite |
| route_011 | smart | smart | ✓ | fast | proof/math rigor | trap: short but hard |
| route_012 | smart | smart | ✓ | fast | estimation/reasoning | trap: short multi-step |
| route_013 | smart | smart | ✓ | fast | systems / distributed | trap: short but deep |
| route_014 | smart | smart | ✓ | fast | system design | complex design |
| route_015 | smart | smart | ✓ | fast | architecture comparison | complex comparison |
| route_016 | smart | smart | ✓ | fast | algorithm complexity | hard algorithm |
| route_017 | smart | smart | ✓ | fast | distributed systems | deep DS question |
| route_018 | smart | smart | ✓ | fast | migration planning | complex planning |
| route_019 | smart | smart | ✓ | fast | performance / debugging | trap: shortish expert |
| route_020 | smart | smart | ✓ | fast | proof/math rigor | trap: short proof |

**Misses:** none. Full JSON: `test/routing_eval_report.json`.

---

## 4. Failover / other phase gates (prior + this session)

| Item | Result | Notes |
|---|---|---|
| Alpha down → beta | PASS | `x-prism-fallback: true`; mocks 18001/18002 |
| Mid-stream no splice | PASS | Unit + adapter design |
| Budget demo key | PASS | `402` / `budget_exceeded` |
| Cross-key cache isolation | PASS (Phase 5) | Research key cannot hit search cache |

---

## 5. How to re-run

```powershell
# Mocks
py -3 scripts\mock_provider.py --port 18001 --name alpha
py -3 scripts\mock_provider.py --port 18002 --name beta

# Gateway (mock mode)
$env:PRISM_UPSTREAM='mock'
$env:PRISM_UPSTREAM_TIMEOUT_MS='1000'
npm start

# Checks
npm run eval:routing
py -3 scripts\smoke_test.py --url http://localhost:8080 --key prism-sk-search-1a2b3c --model fast
py -3 scripts\load_test.py --url http://localhost:8080 --key prism-sk-free-7g8h9i --model fast --requests 30 --concurrency 10 --rpm-limit 10
curl -s "http://localhost:8080/admin/usage?key=prism-sk-free-7g8h9i" -H "Authorization: Bearer prism-admin-demo"
```

Setup and API details: [`README.md`](README.md).

---

## 6. Docker Compose (Stretch)

Files added: `Dockerfile`, `docker/mock.Dockerfile`, `docker-compose.yml`, `.dockerignore`.

| Gate | Intent |
|---|---|
| P7d-1 | `docker compose up --build` → gateway + mocks; health + chat completion |
| P7d-2 | Named volume `prism-db` persists `/data/prism.db` across restarts |
| P7d-3 | Named volume `prism-embeddings` caches MiniLM (`TRANSFORMERS_CACHE` / `HF_HOME`) |

**Runtime note:** Docker Desktop + WSL Ubuntu installed. `docker compose up --build` brought up gateway, mock-alpha, and mock-beta (all healthy). `GET /health` returned `{"status":"ok","upstream":"mock"}`. A `fast` completion with `prism-sk-search-1a2b3c` returned 200 from `alpha/alpha-small` with `x-prism-cache: miss`. DB and embedding volumes are named `prism-db` and `prism-embeddings`.

---

## 7. Known limitations (verification context)

- RPM is single-process; restart clears buckets (intentional for this capstone).
- One smoke paraphrase WARN is allowed by the pack when the other pair hits.
- Load latency includes mock provider time; not a pure gateway microbenchmark.
- Seed trees `data/` and `scripts/` were not modified for these runs.
