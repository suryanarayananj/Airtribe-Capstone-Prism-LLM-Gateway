# Prism

Prism is an LLM API gateway: one OpenAI-compatible door for apps, with virtual keys, budgets, rate limits, model aliases (`fast` / `smart` / `auto`), semantic cache, and alpha→beta failover. An admin console and optional chat UI sit on top of the same gateway.

**Verification report:** [`VERIFICATION.md`](VERIFICATION.md) (smoke, load, routing eval, accounting, latency).

---

## High-level design

```mermaid
flowchart LR
  api[Via_API] --> gateway[Fastify_gateway]
  adminApp[React_admin] --> gateway
  chatApp[React_chat] --> gateway
  gateway --> sqlite[(SQLite_prism_db)]
  gateway --> embed[Local_embedding_model]
  gateway --> adapter[Provider_adapter]
  adapter --> alpha[Provider_alpha]
  adapter --> beta[Provider_beta]
```

| Piece | Role |
|---|---|
| **Via API** | Calls `POST /v1/chat/completions` with a virtual key |
| **React admin** (`web/admin`, `:5173`) | Ops console → `/admin/*` (usage, requests, cache, plans, teams, users, charts) |
| **React chat** (`web/chat`, `:5174`) | Browser chat → `/app/*` (username/password; server holds the virtual key) |
| **Fastify gateway** (`src/`) | HTTP shell for auth, limits, budget, guardrails, **routing**, cache, metering, logs |
| **`auto` router** (inside gateway) | Local rules first; if unclear, optional small LLM classifier (`openai/gpt-4o-mini` via OpenRouter) → `fast` or `smart` |
| **SQLite** (`data/prism.db`, WAL) | Keys, usage, request logs, cache vectors, plans / teams / users |
| **Local MiniLM** | Embeddings for per-key semantic cache (not for routing) |
| **Adapter** | One upstream client → mock **alpha/beta** or OpenRouter (config swap only) |

---

## Technology stack (and why)

| Technology | Where | Why we used it |
|---|---|---|
| **Node.js 22+** | Gateway runtime | Native `node:sqlite`, modern ESM, good enough for SSE streaming |
| **Fastify** | HTTP server | Low overhead, plugins, fits a streaming gateway better than a heavy MVC stack |
| **SQLite + WAL** (`node:sqlite` DatabaseSync) | `data/prism.db` | Single-process atomic budget/usage updates; no external DB |
| **In-process RPM / TPM / health** | `limiter.js`, `health.js` | One gateway instance; buckets reset on restart by design |
| **`@xenova/transformers` (MiniLM)** | Semantic cache | Local embeddings — no paid embedding API; works offline with mocks |
| **Python mock providers** | `scripts/mock_provider.py` | Free, deterministic failover / smoke / load drills |
| **OpenRouter** (optional) | Via adapter only | Live demo / optional `auto` classifier; same adapter as mocks |
| **Vite + React** | `web/admin`, `web/chat` | Separate products; separate ports/caches |
| **Recharts** | Admin Overview / Accounting | Usage, cost, latency, routing charts |
| **Docker Compose** | Gateway + mocks | One-command mock stack; DB + embedding volumes |

---

## Features

### Must Have

- OpenAI-compatible `POST /v1/chat/completions` with `x-prism-*` headers
- Virtual-key auth, model allowlist, RPM, monthly USD budget, metering from provider `usage` × price table
- Request logs + usage totals; admin visibility of traffic / spend / cache
- Streaming SSE without buffering the full upstream reply
- Multi-provider **alpha → beta** failover + retries/timeouts
- `fast` / `smart` / `auto` aliases; `auto` difficulty routing + routing eval
- Per-key semantic cache (paraphrase hits; no cross-key leak)
- Guardrails + cheap→smart escalation on refuse-style answers
- Ops console (usage, requests, cache)
- Works with smoke / load / mock providers

### Good To Have (shipped)

- TPM limits (reserve / finalize)
- Virtual key create / disable / enable / rotate
- Degradation-based failover + provider health
- Cache TTL + multi-chunk SSE replay on cache hits
- Usage charts + richer observability (latency percentiles, routing buckets, provider ok/error)

### Stretch (shipped)

- Least-latency (and optional weighted) ordering among healthy providers
- Docker Compose packaging for gateway + mocks

### Additional features we added

**Admin console (`web/admin`)**

- **Overview** — this-month cost/tokens; daily / by-model charts with **Tokens ↔ Cost** toggle and date/month range; routing buckets; latency; provider health table
- **Requests** — request log with counts (“Showing X of Y”)
- **Cache** — entries + hits inspection, stats (process + lifetime hit rate), delete
- **Providers** — online (OpenRouter) vs offline (mock) alias → slot map
- **Accounting** — this-month cost, cost-by-provider chart (this month), month picker on provider table
- **Access → Plan / Team / User** — CRUD; creating a **User** mints a new **virtual API key** from the team’s plan; **editing a plan** rewrites active keys on teams using that plan
- **Virtual Keys** — list + disable / enable / rotate (seed keys protected); secret **eye toggle** masking
- Plan rules include allowlist, cache threshold, guardrail modes (`off` / `flag` / `block` / `redact`), optional **Verify** checker models
- User **access modes**: API only / Chat only / Both

**Chat app (`web/chat`)**

- Username/password sign-in (no key paste); conversation history (create / rename / delete) + SSE streaming
- **Token usage** bar (used vs monthly token cap; “no limit” when uncapped)
- **Token predictor** (live estimated tokens in the composer)
- **Token warnings** at 70% / 80% / 90% / 95%+ of the monthly cap
- Multi-model **Verify** toggle + ✓ verified mark on replies (when plan has checker models)
- Seeded demo login: `demo` / `demo123`

---

## Request pipeline (data plane)

1. Client sends `POST /v1/chat/completions` with `Authorization: Bearer <virtual-key>` and alias `fast` / `smart` / `auto`.
2. Authenticate key → allowlist → consume one RPM slot (**no `await` between check and consume**) → TPM reserve → monthly budget / token caps.
3. Guardrails inspect the prompt (per-key modes: off / flag / block / redact).
4. If `auto`: local rules first; optional small classifier when OpenRouter is configured. Resolve alias → primary + fallbacks.
5. Semantic cache lookup for **this virtual key + model only**. Hit → stored success, `x-prism-cache: hit`, cost `0` (RPM still consumed).
6. Miss → adapter calls upstream with timeout + retries; on failure before first client byte → next model, `x-prism-fallback: true`.
7. Stream SSE as chunks arrive (`data: [DONE]` at end). Mid-stream failure ends the client stream — **no** silent provider splice.
8. Cost from provider `usage` × `data/model_pricing.json`. Write request log + atomic usage increment. Store successful responses in cache.

**Browser chat:** `POST /app/login` → session token → `POST /app/chat` proxies to `/v1` with that user’s virtual key and streams SSE back. The browser never sees upstream API keys.

---

## Quick start (mock providers — offline demo)

Use this path for local verification and pack scripts. On Windows, ports `9001`/`9002` are often blocked; this project defaults mocks to **18001** / **18002**.

### Prerequisites

- Node.js **≥ 22**
- Python **3.9+** (`py -3` on Windows)
- npm

### 1. Install

```powershell
cd "path\to\Prism Project"
npm install
npm --prefix web install
```

### 2. Environment

Copy `.env.example` → `.env` (or set the vars below). For the mock demo:

```env
PRISM_PORT=8080
PRISM_HOST=0.0.0.0
PRISM_UPSTREAM=mock
PRISM_ALPHA_BASE_URL=http://127.0.0.1:18001/v1
PRISM_BETA_BASE_URL=http://127.0.0.1:18002/v1
PRISM_ALPHA_API_KEY=mock-key-alpha
PRISM_BETA_API_KEY=mock-key-beta
PRISM_UPSTREAM_TIMEOUT_MS=1000
PRISM_ROUTING_STRATEGY=failover
PRISM_CACHE_TTL_SECONDS=86400
PRISM_ADMIN_TOKEN=prism-admin-demo
```

Restart the gateway after any `.env` change. A variable already set in the shell wins over `.env`.

Optional OpenRouter (live demo / optional classifier — not required for smoke/load):

```env
PRISM_UPSTREAM=openrouter
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

### 3. Start mock providers + gateway

```powershell
# Terminal 1
py -3 scripts\mock_provider.py --port 18001 --name alpha

# Terminal 2
py -3 scripts\mock_provider.py --port 18002 --name beta

# Terminal 3
npm start
```

Health check: `GET http://localhost:8080/health`

### 4. Optional UIs

```powershell
npm run admin   # http://localhost:5173
npm run chat    # http://localhost:5174
```

Admin uses `Authorization: Bearer prism-admin-demo` (or `PRISM_ADMIN_TOKEN`).

**Demo chat login** (seeded on first boot; research team → `fast` / `smart` / `auto`):

| Field | Value |
|---|---|
| Username | `demo` |
| Password | `demo123` |
| Monthly token cap | 50,000 (so the usage bar / warnings show in demos) |

You can still create more users in admin → Access. Chat never asks for a virtual key.

### 5. Docker Compose (Stretch)

Requires [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Compose v2).

```powershell
docker compose up --build
```

| Service | Role | Host port |
|---|---|---|
| `gateway` | Prism Fastify API | `8080` |
| `mock-alpha` | Mock provider | `18001` → container `9001` |
| `mock-beta` | Mock provider | `18002` → container `9002` |

**Volumes:** `prism-db` → `/data/prism.db`; `prism-embeddings` → MiniLM cache.

**Quick check**

```powershell
curl.exe http://localhost:8080/health
curl.exe -s http://localhost:8080/v1/chat/completions `
  -H "Authorization: Bearer prism-sk-search-1a2b3c" `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"fast\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}"
```

Failover drill (alpha on 18001):

```powershell
curl.exe -s -X POST http://127.0.0.1:18001/admin/config -H "Content-Type: application/json" -d "{\"mode\":\"down\"}"
```

Admin/Chat UIs still run on the host against `http://localhost:8080`. Stop local `npm start` first so port 8080 is free.

Stop: `docker compose down` (keep volumes) or `docker compose down -v` (wipe DB + embeddings).

---

## Seeded demo keys

Keys are loaded from `data/seed_keys.json` into SQLite on first boot. **Do not edit** files under `data/` or `scripts/`; override via env/config only.

| Virtual key | Team | Budget | RPM | Allowlist | Semantic cache | Use for |
|---|---|---|---|---|---|---|
| `prism-sk-search-1a2b3c` | search | $50 | 60 | `fast` | on (threshold **0.92**) | Smoke / happy path |
| `prism-sk-research-4d5e6f` | research | $500 | 300 | `fast`, `smart`, `auto` | **off** | Routing / multi-alias |
| `prism-sk-free-7g8h9i` | free-tier | $5 | **10** | `fast` | on (0.85) | Load / over-admission |
| `prism-sk-budget-demo-0j1k2l` | budget-demo | **$0.00001** | 60 | `fast` | **off** | Budget exhaustion demo |

**Chat UI demo user** (separate from the seed keys above): username `demo` / password `demo123` (team **research**, access **both**, token cap **50,000**).

### Reproduce the mock demo

1. Start alpha/beta mocks + gateway with `PRISM_UPSTREAM=mock` (steps above).
2. Happy path:

```powershell
curl.exe -s http://localhost:8080/v1/chat/completions `
  -H "Authorization: Bearer prism-sk-search-1a2b3c" `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"fast\",\"messages\":[{\"role\":\"user\",\"content\":\"What is a message queue?\"}]}"
```

Expect `200`, OpenAI-shaped body, headers `x-prism-provider`, `x-prism-cache`, `x-prism-fallback`, `x-prism-cost-usd`.

3. Smoke + load:

```powershell
py -3 scripts\smoke_test.py --url http://localhost:8080 --key prism-sk-search-1a2b3c --model fast
py -3 scripts\load_test.py --url http://localhost:8080 --key prism-sk-free-7g8h9i --model fast --requests 30 --concurrency 10 --rpm-limit 10
```

4. Budget reject (cache off so a hit cannot mask it):

```powershell
curl.exe -s -i http://localhost:8080/v1/chat/completions `
  -H "Authorization: Bearer prism-sk-budget-demo-0j1k2l" `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"fast\",\"messages\":[{\"role\":\"user\",\"content\":\"Long enough prompt to exceed the tiny monthly budget for budget-demo.\"}]}"
```

5. Live failover drill:

```powershell
curl.exe -s -X POST http://127.0.0.1:18001/admin/config -H "Content-Type: application/json" -d "{\"mode\":\"down\"}"
# Chat with fast → expect beta + x-prism-fallback: true
curl.exe -s -X POST http://127.0.0.1:18001/admin/config -H "Content-Type: application/json" -d "{\"mode\":\"ok\",\"fail_rate\":0}"
```

6. Routing eval (local rules; no live upstream required):

```powershell
npm run eval:routing
```

---

## API documentation

### Auth

| Plane | Mechanism |
|---|---|
| Data plane | `Authorization: Bearer <virtual-key>` |
| Admin | `Authorization: Bearer <PRISM_ADMIN_TOKEN>` (default `prism-admin-demo`) |
| Chat app | Session token from `POST /app/login` |

### Data plane

#### `POST /v1/chat/completions`

OpenAI-compatible. Body: `model` (`fast` | `smart` | `auto` or raw id), `messages`, optional `stream`.

**Pipeline order:** auth → allowlist → RPM → TPM (reserve) → budget/token caps → guardrails → route → cache → upstream adapter → meter + log (TPM finalize).

**Response headers:**

| Header | Meaning |
|---|---|
| `x-prism-provider` | Upstream that served, e.g. `alpha/alpha-small` |
| `x-prism-cache` | `hit` or `miss` |
| `x-prism-fallback` | `true` when a fallback model served |
| `x-prism-cost-usd` | Metered USD (always `0` on cache hit; omitted on stream responses — cost still logged) |
| `x-prism-escalation` | `true` when a refuse-style answer was retried on the stronger tier |

Streaming: `Content-Type: text/event-stream`, chunks as `data: …`, ends with `data: [DONE]`. Mid-stream upstream failure ends the client stream; Prism does **not** splice another provider mid-response.

#### Error shapes

OpenAI-style `{ "error": { "message", "type", "code" } }`:

| Case | Status | `type` |
|---|---|---|
| Bad / missing key | 401 | `authentication_error` |
| Model not allowlisted | 403 | `model_not_allowed` |
| RPM exceeded | 429 | `rate_limit_exceeded` |
| TPM exceeded | 429 | `tpm_limit_exceeded` |
| Budget exhausted | **402** | `budget_exceeded` |
| Unknown model | 404 | `not_found_error` |
| All providers failed | 502 | `upstream_error` |
| Guardrail block | 400 | injection / invalid request |
| Empty messages | 400 | `invalid_request_error` |

### Admin

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/admin/usage?key=` | Usage totals (reconcile with load-test cost sums) |
| `GET` | `/admin/logs?limit=` | Recent request logs |
| `GET` | `/admin/cache/stats` | Hits / misses |
| `GET` | `/admin/cache/entries`, `/admin/cache/hits` | Cache inspection |
| `GET` | `/admin/keys` | Virtual keys |
| `POST` | `/admin/keys` | Create key (`team` + `plan_id` or explicit limits) |
| `POST` | `/admin/keys/:id/disable` · `/enable` · `/rotate` | Key lifecycle (seed keys protected) |
| `GET/POST/PATCH` | `/admin/plans`, `/admin/teams`, `/admin/users` | Ops CRUD (create user mints a key from the team plan) |
| `GET` | `/admin/observability` | Latency percentiles, per-provider outcomes, routing buckets |
| `GET` | `/admin/providers/health` | Live degradation window |
| `GET` | `/admin/providers/catalog` | Alias → slot map (mock ids + OpenRouter ids) |
| `GET` | `/admin/models` | Assignable alias list for plans |
| `DELETE` | `/admin/records/:table/:id` | Delete one row |
| `DELETE` | `/admin/records/:table` | Clear a table (with FK guards) |

### Chat app

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/app/login` | Username/password → session |
| `GET` | `/app/me` | Profile + allowlist |
| `POST` | `/app/chat` | Proxied completion (streams; uses user’s virtual key server-side) |
| CRUD | `/app/conversations` | Server-side chat history |

### Other

- `GET /health` — liveness

Default ports: gateway `8080`, admin `5173`, chat `5174`.

---

## Gateway modules

| Module | Role |
|---|---|
| `src/server.js` | Fastify app entry |
| `src/config.js` | Env, pricing, seed keys, aliases, OpenRouter mapping |
| `src/db.js` | SQLite schema, seed, queries |
| `src/auth.js` | Virtual-key auth + allowlist |
| `src/adminAuth.js` | Admin Bearer token for `/admin/*` |
| `src/passwords.js` | scrypt hash/verify for chat users |
| `src/limiter.js` | Sync RPM + TPM reserve/finalize |
| `src/budget.js` | Monthly USD + token caps |
| `src/router.js` | `auto` classification |
| `src/cache.js` | Per-key semantic cache |
| `src/metering.js` | Cost from upstream `usage` × `data/model_pricing.json` |
| `src/guardrails.js` | Injection / PII checks |
| `src/health.js` | Provider samples, degradation, least-latency ordering |
| `src/errors.js` | `PrismError` + OpenAI-style envelope |
| `src/providers/adapter.js` | HTTP, timeout, retry, failover, SSE |
| `src/routes/chat.js` | `POST /v1/chat/completions` |
| `src/routes/admin.js` | Ops APIs |
| `src/routes/appChat.js` | Login + browser chat proxy |

---

## Persistence (SQLite)

| Table | Contents |
|---|---|
| `plans` | Budget, RPM, TPM, token cap, allowlist, cache, guardrail modes, verify models |
| `teams` | Name + `plan_id` |
| `users` | Name, team, username/password, access mode, token cap |
| `chat_sessions` | Session token for signed-in chat user |
| `virtual_keys` | Per-user (or seed) metered key; limits copied from plan |
| `usage` | Per key × calendar month: requests, tokens, cost, cache hits |
| `request_logs` | One row per request (including rejections) |
| `cache_entries` | Per virtual key + model; prompt, embedding, response |
| `cache_hits` | One row per served cache hit (score, prompt, request id) |
| `conversations` / `conversation_messages` | Chat history |

Seed key strings and alias names (`fast`, `smart`, `auto`) are preserved from `data/seed_keys.json` / `data/gateway_config.sample.json`.

---

## Routing and failover design

**Aliases** (from `data/gateway_config.sample.json`):

| Alias | Primary | Fallback |
|---|---|---|
| `fast` | `alpha-small` | `beta-small` |
| `smart` | `alpha-large` | `beta-large` |
| `auto` | Classify → then `fast` or `smart` chain | same |

**`auto` method:** local rules first (cheap, works offline). If confidence is low and an OpenRouter key is configured, an optional small classifier may run. Eval labels (`expected_tier` in `data/routing_eval.jsonl`) are **never** read at request time — only for scoring. Target: beat ~60% length baseline (aim 80%+).

**Failover:** adapter tries the chain with timeout + retries. On primary failure or timeout **before** bytes are committed to the client → next model and `x-prism-fallback: true`. A timeout does not retry that same provider; it moves on. Other errors still retry up to 3 times with backoff. Mid-stream failure → end client stream with error (no silent provider splice).

**Escalation:** if a non-streaming cheap-model answer is a refusal, Prism retries on `smart`, sets `x-prism-escalation: true`, and logs `escalated_to_smart`. On the mocks, a `*-small` model refuses when the prompt contains `[refuse]`. Streaming calls do not escalate. A cache hit skips this step.

**Guardrails:** per key/plan, each of injection and PII is `off`, `flag`, `block`, or `redact`. Seeded default is injection=`block` (HTTP 400) and PII=`flag` (request still returns 200; the request log reason shows `pii:flag`).

### Behavior switches

Set these in `.env`, then restart.

| Setting | Values | What it changes |
|---|---|---|
| `PRISM_UPSTREAM` | `mock` (default) or `openrouter` | Mock alpha/beta, or live OpenRouter. Mock admin latency (`POST http://127.0.0.1:18001/admin/config`) only applies in `mock` mode. |
| `PRISM_UPSTREAM_TIMEOUT_MS` | milliseconds, default **1000** | How long one upstream call may run before Prism gives up and tries the next provider. Alpha `latency_ms: 3000` fails over only when this value is lower than 3000. Use a higher value (for example 15000) for OpenRouter. |
| `PRISM_ROUTING_STRATEGY` | `failover` (current), `least_latency`, or `weighted` | Who is tried first among **healthy** providers. |
| `PRISM_CACHE_TTL_SECONDS` | seconds, default **86400** (24 hours) | How long a new cache entry stays eligible. A per-key `cache_ttl_seconds` overrides this. Expired rows are ignored, so the next similar prompt is a miss. |
| `PRISM_CLASSIFIER_MODEL` | OpenRouter model id, default `openai/gpt-4o-mini` | Optional `auto` judge, used only when local-rule confidence is low and `OPENROUTER_API_KEY` is set. |
| `PRISM_ADMIN_TOKEN` | string, default `prism-admin-demo` | Bearer token for the admin API and console. |

**Routing strategy**

- `failover` — keep config order. `fast` always tries alpha first, then beta. This is what the provider-failure demo uses.
- `least_latency` — among healthy providers, try the one with the lowest recent average latency first. After one slow alpha call, the next request can go straight to beta.
- `weighted` — same idea, but latency is divided by the provider weight (`alpha` 1, `beta` 1 unless the sample config sets weights).

**Degradation** (on for every strategy): in a 60-second window, once a provider has at least 3 samples and either an error rate ≥ 50% or p95 latency ≥ 5000 ms, it is marked degraded. Healthy providers are tried before degraded ones. The admin Overview **Provider health** table shows this. The label clears as those samples age out.

---

## Upstream modes

```text
Gateway core  →  Provider adapter  →  Pack mocks alpha / beta     (offline / smoke / load)
                                   →  OpenRouter (mapped slots)   (live demo / classifier)
                                   →  Real providers              (production: same adapter)
```

When `PRISM_UPSTREAM=openrouter`, slots map to vendor ids (defaults):  
`alpha-small` / `beta-large` → `openai/gpt-4o-mini`, `alpha-large` / `beta-small` → `google/gemini-2.0-flash-001`.

---

## Cache scoping

- **Scope:** per **virtual key** (+ model). No cross-key leakage.
- **Embeddings:** local `Xenova/all-MiniLM-L6-v2` (no paid embedding API).
- **Keying:** last user message (Must Have paraphrase pairs are single-turn).
- **Threshold:** from seed / plan (search **0.92**, free-tier **0.85**; default **0.85** if unset).
- **Store:** successful responses only; hits bill **$0** cost header but still consume RPM.
- **Replay:** cache hits are emitted as proper OpenAI-style SSE chunks with `x-prism-cache: hit`.
- **Near-miss:** unrelated prompts must miss at the search threshold.

---

## Design decisions

| Choice | Why |
|---|---|
| Fastify + plain JS + SQLite WAL | Low-overhead streaming; atomic budget/usage; single-process grading |
| `node:sqlite` DatabaseSync | Sync API + WAL; avoids native compile issues with better-sqlite3 on some Windows setups |
| Sync RPM (no await between check and consume) | Zero over-admission under `load_test.py` concurrency |
| In-process RPM/TPM (not Redis) | One gateway instance; buckets reset on restart by design |
| Budget → `402` (not `429`) | Distinguish money from rate limits |
| Admit when remaining budget > 0 | Streams may finish slightly over cap by final cost; pack allows this |
| Cost from provider `usage` × price table | Clients cannot lie about tokens |
| Permanent `providers/adapter.js` | Mocks / OpenRouter / real providers are config swaps, not route forks |
| Keep pack alpha/beta + `fast`/`smart`/`auto` names | Smoke/load/seeds depend on those strings |
| Prefer mocks for failover/load; OpenRouter for live demo | Deterministic drills vs polished answers — same adapter |
| Never splice mid-stream | Pack forbids silent provider handoff after first byte |
| `auto` = local rules first, then optional classifier | Latency/cost + offline survival; length-only fails short-hard traps |
| Never read `expected_tier` at request time | Eval labels are for scoring only |
| Semantic cache per virtual key (+ model) | Teams never see another key’s answers |
| Cache successes only; `$0` on hit; RPM still consumed | Matches header contract; cache is not a rate-limit bypass |
| Local MiniLM embeddings | No paid embedding API; paraphrase hits required |
| Demo admin Bearer token (not full IdP) | Fast ops console; chat users use scrypt passwords separately |
| Admin + chat as separate Vite apps | Different products; ports `5173` / `5174` |
| Plan on team → virtual key per user | Shared team key would mix budgets and cache |
| Guardrails per key/plan (`block`/`flag`/`redact`/`off`) | Defaults: injection=`block`, PII=`flag` |
| Seed `data/` + `scripts/` treated as read-only | Override via `.env` / config only |
| Routing strategy `failover` for the demo (`PRISM_ROUTING_STRATEGY`) | Least-latency is implemented, but it skips a slow alpha on the next call and hides the timeout demo |

---

## Tests and verification commands

```powershell
# Unit tests
npm test

# Routing accuracy vs length baseline
npm run eval:routing

# Contract smoke (needs gateway + mocks)
py -3 scripts\smoke_test.py --url http://localhost:8080 --key prism-sk-search-1a2b3c --model fast

# Over-admission + client accounting + latency (needs gateway + mocks)
py -3 scripts\load_test.py --url http://localhost:8080 --key prism-sk-free-7g8h9i --model fast --requests 30 --concurrency 10 --rpm-limit 10

# Reconcile accounting
curl.exe -s "http://localhost:8080/admin/usage?key=prism-sk-free-7g8h9i" -H "Authorization: Bearer prism-admin-demo"
```

Captured results: [`VERIFICATION.md`](VERIFICATION.md).

---

## Known limitations

- RPM is **process-local**; resets on restart; not multi-instance fair.
- Semantic cache quality depends on MiniLM + threshold; paraphrase soft-WARN alone is allowed by smoke if at least one pair hits.
- OpenRouter classifier is optional; offline mocks rely on local `auto` rules.
- Single SQLite writer process is the intended deployment for this project.
- Stretch **not** claimed: debate multi-call flows, Redis / multi-instance limits, org rollups.
- Docker Compose is provided (`Dockerfile`, `docker-compose.yml`); first embedding download still needs network once unless the `prism-embeddings` volume is warm.

---

## Project layout

```text
src/                    Gateway (Fastify)
web/admin/              Admin UI (:5173)
web/chat/               Chat UI (:5174)
data/                   Seeds, gateway sample config, pricing (do not edit)
scripts/                Mock providers, smoke, load (do not edit)
test/                   Unit + routing/cache eval helpers
Dockerfile              Gateway image
docker/mock.Dockerfile  Mock provider image
docker-compose.yml      Gateway + alpha/beta mocks + volumes
VERIFICATION.md         Smoke / load / routing / latency report
README.md               This file (setup, API, architecture, decisions)
```

---

## Try Prism (live demo)

### 1. Wake the API

Open this link first and wait until you see `"status":"ok"`:

https://prism-gateway-wlzq.onrender.com/health

### 2. Open the apps

| App | URL |
|---|---|
| Chat | https://prism-chat-theta.vercel.app |
| Admin | https://prism-admin-theta.vercel.app |

### 3. Try Chat

1. Sign in with:
   - Username: `demo`
   - Password: `demo123`
2. Ask something (e.g. “What is an LLM?”).
3. Ask a similar question again to see caching in action.
4. Check **Recent** for conversation history.

### 4. Try Admin

1. Open the Admin app.
2. Browse Overview, Requests, Cache, Providers, and Access.
3. Confirm the chat request appears under Requests, and cache activity under Cache.

### Quick links

- Health: https://prism-gateway-wlzq.onrender.com/health
- Chat: https://prism-chat-theta.vercel.app
- Admin: https://prism-admin-theta.vercel.app
