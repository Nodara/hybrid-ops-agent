# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An internal user-administration copilot (NestJS 10 + TypeScript, SQLite via `better-sqlite3`,
Claude via `@anthropic-ai/sdk`). Ops staff send natural-language requests to a single
`POST /orchestrate` endpoint; a classifier agent decides whether the request is handled by a
deterministic, code-defined flow or by a model-driven agent loop.

This repo is "Product 1 — UserAdmin Agent" out of a four-product spec described in
`PRODUCT_SPECS.md`. **Only Product 1 is implemented here.** The Product 1 production-realism
requirements — per-transaction audit writes, idempotent suspend, actor-role authorization
checks, and a blast-radius ceiling independent of risk escalation — **are built** (see "Shared
services" and "Deterministic flows" below). `PRODUCT_SPECS.md` otherwise still describes a
target/aspirational spec for Products 2–4 (SupportDesk, RevenueInvestigator, etc.), none of
which exist in this codebase; treat that file as a design reference for those, not a
description of current behavior. For what's actually implemented vs. missing, trust the
README's "Known gaps" section and the code itself over `PRODUCT_SPECS.md`.

## Commands

```bash
npm run start:dev          # NestJS with watch mode (local dev)
npm run build               # nest build
npm run start:prod          # node dist/main.js
npm run seed                 # wipe + reseed the DB standalone (same path as boot)
npm run lint                 # eslint --fix — currently fails: eslint is not in devDependencies
npm test                     # jest — currently fails: jest is not in devDependencies, no *.spec.ts files exist
npm run run:container:watch  # docker compose up with dev overlay (live reload in container)
```

There is no test suite and no lint tooling installed yet, despite the npm scripts existing.
If asked to add tests, `src/orchestrator/flows/risk-assessment.ts` is a pure function and the
natural first target.

### Docker

```bash
cp .env.example .env      # then set ANTHROPIC_API_KEY
docker compose up --build
```

Compose fails fast if `ANTHROPIC_API_KEY` is unset. SQLite lives in the named volume
`useradmin-data`, which survives restarts — but the boot-time wipe (see below) means the data
doesn't. The dev compose overlay bind-mounts the project but shadows `node_modules` with an
anonymous volume so the container keeps its Linux-built `better-sqlite3` binary.

## Architecture

```
POST /orchestrate
      │
      ▼
ClassifierService ── one Claude call, tool_choice forced to `route_request`
      │              → { route, flow, domain, csv_text, tool_sequence, reasoning }
      │
      ├── route = "deterministic" AND required param present
      │     ├── suspend_users_by_domain   → SuspendByDomainFlow
      │     └── bulk_create_users_from_csv → BulkCreateUsersFlow
      │
      └── route = "model_driven"  (or deterministic flow missing its param)
            └── AgentService — hand-rolled tool loop, 6 tools, tool_choice: auto
```

`POST /flows/suspend-domain` and `POST /flows/bulk-onboard` (`orchestrator/flows.controller.ts`)
call `SuspendByDomainFlow` and the newer `BulkOnboardUsersFlow` directly, bypassing the
classifier entirely — for callers that already know which flow they want. `bulk_onboard_users`
is reachable **only** through this direct endpoint today; the classifier still routes
natural-language CSV requests to `bulk_create_users_from_csv`, not to `bulk_onboard_users`.

Everything shares one `UsersService`, and every mutation writes an `audit_log` row regardless
of which path produced it, in the same DB transaction as the mutation (see "Shared services").

**Safety rule (`orchestrator/orchestrator.service.ts`):** if the classifier picks a
deterministic flow but the required parameter (`domain` / `csv_text`) is missing or blank,
the orchestrator does **not** guess — it logs a warning and falls back to the model-driven
engine, which can ask the operator for clarification. The response's top-level `route`
always reports what *actually* ran, which may differ from `classification.route`.

### Why the classifier/deterministic split exists

Suspending an entire email domain and bulk-creating users from CSV are common, high-volume,
and dangerous enough that control flow shouldn't be left to a model — they run as fixed step
sequences in code. Everything else (single-user lookups, updates, ambiguous or multi-step
requests) goes to the model-driven engine.

### Deterministic flows (`src/orchestrator/flows/`)

- **`suspend_users_by_domain`** — `find_users_by_domain → assess_risk → escalate_or_suspend`.
  Domain is normalized (`@Acme.com`, `mailto:`, trailing slashes → `acme.com`) and matched
  with `lower(email) LIKE '%@domain'`, no `LIMIT` (needs the complete set for risk
  assessment). Risk scoring is a **pure function** in `flows/risk-assessment.ts` (+40 per
  admin in scope, +10 per editor, blast radius `min(matches,25)×2`, `+min(active,20)` for
  active accounts; ≥70 high, ≥35 medium). Escalates to a human instead of auto-suspending if
  more than 3 users match (`MAX_AUTO_SUSPEND`), any matched user is an admin, risk is high, or
  more than 50 users match (`MAX_SUSPEND_PER_INVOCATION`, checked independently of the other
  three so it still applies even if `MAX_AUTO_SUSPEND` is ever raised) — otherwise suspends
  every matched non-deleted account (already-suspended accounts are still passed through
  `suspend()`, which idempotently no-ops the row update but still audits the attempt).
  `matched_sample` caps at 20; `matched_count` is the true total. With the seeded data (~350
  accounts/domain) this flow **always escalates** — exercising the auto-suspend path requires
  a fresh domain with ≤3 matches, no admins, low/medium risk.
- **`bulk_create_users_from_csv`** — `parse_csv → create_users`. Optional header row detected
  by an `email` column (any order); without one, columns are assumed `email,name,role`.
  Handles simple double-quote wrapping but not embedded commas. Each row is created
  independently — a bad row lands in `failed` with its line number and error and does not
  abort the rest (partial success, no rollback). Reachable via `POST /orchestrate` (classifier
  or model-driven agent); not exposed as its own `/flows/*` route today.
- **`bulk_onboard_users`** (`flows/bulk-onboard-users.flow.ts`) — takes a `rows:
  {email,name,role}[]` array directly (no CSV parsing), unlike the flow above. Two-phase:
  `validate_rows` checks every row (format, role, duplicate-in-batch, duplicate-in-DB) before
  any writes happen; `create_valid_rows` then creates every row that passed validation inside
  **one atomic transaction** (`UsersService.runAtomically`) — they all commit together, or (if
  something unexpected fails mid-write) none do. Rejects the whole batch outright above 500
  rows rather than truncating it. Returns a per-row result array with
  `status: "created" | "skipped"` and, for skips, a `reason` (`invalid_format` /
  `invalid_role` / `duplicate_in_batch` / `duplicate_in_db` / `write_failed`). Reachable only
  via `POST /flows/bulk-onboard` — the classifier does not route to it.

### Model-driven engine — Mode A (`src/agent/agent.service.ts`)

Hand-rolled tool loop (not the SDK's agent/tool-runner helper) so it can: log every turn
(`agent/turn-logger.service.ts` — tool calls with arguments, `stop_reason`, token counts, also
echoed to stdout); terminate cleanly when the model calls `escalate_to_human`; and cap
iterations at `MAX_ITERATIONS`. The full assistant turn (including thinking blocks) is pushed
back onto `messages` each iteration so the model retains its reasoning across tool calls;
parallel tool calls execute together and return as `tool_result` blocks in a single user turn.
`escalate_to_human` is checked **before** any tools execute in that turn — if the model calls
it alongside other tools, those other tools do not run and the loop breaks immediately with no
`tool_result` returned.

Six tools (`src/agent/tools.ts`): `search_users` (free-text, optional `role`
[admin/editor/viewer/customer]/`status`/`country`/`city` filters, `LIMIT 50` — e.g. a
customer lookup by email is `search_users({ query: email, role: "customer" })`), `get_user`,
`create_user` (email format validated in code via `isValidEmail` in `user.types.ts`, not
described to the model; email lowercased; uniqueness enforced), `update_user` (partial,
rejects empty field set), `suspend_user` (`reason` required in the tool's `input_schema`
itself, not just prose), `escalate_to_human` (terminates the loop; `risk_level` ∈
low/medium/high/critical). Invalid input is returned to the model as an `is_error` tool
result so it can self-correct rather than crashing the loop.

### Shared services

- `AnthropicService` (`src/llm/anthropic.service.ts`) constructs the Anthropic client
  **lazily** — the app boots and serves read-only routes even without
  `ANTHROPIC_API_KEY`; calling `/orchestrate` without it returns 503. Used by the classifier.
- **`AgentService` builds its own separate Anthropic client** and reads `ANTHROPIC_MODEL`
  directly instead of going through `AnthropicService` — both resolve to the same values
  today, but a config change has to be made in two places. Known duplication, not yet fixed.
- `UsersService` is the single source of truth for user mutations; every deterministic flow
  and every agent tool goes through it, and every mutation writes an `audit_log` row.
  - **Transactional audit writes:** `create`/`update`/`suspend` each wrap their row mutation
    and audit insert in one SQLite transaction (`UsersService.inTransaction`) — if the audit
    write throws, the mutation rolls back with it. `runAtomically` exposes the same mechanism
    publicly so a flow (e.g. `bulk_onboard_users`) can compose several `create` calls into one
    atomic batch.
  - **Idempotent `suspend`:** re-suspending an already-suspended user skips the row UPDATE but
    still writes an audit row (`details.idempotent_noop: true`) — retries/double-clicks are
    logged, not errored or double-applied.
  - **Actor-role ACL (`UsersService.authorize`):** every mutating method resolves `actor` to a
    role — a `users.email` match uses that user's actual role; anything else (e.g. the
    `"ops-console"` system label used when no operator identity is passed) is treated as a
    trusted internal caller and resolves to `admin`. Permission matrix: `viewer` → no
    mutations; `editor` → `create_user`/`update_user` only; `admin` → everything, including
    `suspend_user`. Enforced in `UsersService` itself (not the tool prompt or schema), so it
    applies uniformly to agent tool calls and deterministic flows.

## Data model

```
users(id, email, name, role[admin|editor|viewer|customer], status[active|suspended|deleted],
      country, city, created_at)
audit_log(id, actor, action, target_user_id, timestamp, details)
transactions(id, user_id, type[subscription_charge|refund|balance_credit|balance_debit],
             amount_cents, currency, created_at, metadata)
```

`audit_log.target_user_id` and `transactions.user_id` are foreign keys into `users`;
`journal_mode=WAL` and `foreign_keys=ON` are set at boot. The SQLite schema is designed to map
1:1 to Postgres. `country`/`city` are nullable and only set by the seed generator today — no
tool or endpoint lets an operator set them on create/update. `transactions` is seeded but
nothing in Product 1 reads it yet (it exists for Product 3/RevenueInvestigator per
`PRODUCT_SPECS.md`, which isn't built in this repo).

### ⚠️ The database is wiped on every boot

`DatabaseService.onModuleInit()` (`src/database/database.service.ts:21`) runs
`createSchema() → cleanUpAllTables() → seedIfEmpty()`. `cleanUpAllTables()` deletes every row
from all three tables and resets autoincrement counters, so the reseed **always** runs — IDs
are not stable across restarts. The seed generates 2500 users (roles round-robin
admin/editor/viewer/customer; every 10th account `suspended`, every 25th `deleted`; each user
gets a **random** domain from `example.com`, `acme.com`, `globex.com`, `initech.io`,
`umbrella.co`, `hooli.com`, `wayne-enterprises.com`, and a **random** country/city pair from a
fixed list), so per-domain counts vary (~350 each) across boots. Every seeded `customer`
account gets 0–3 sample `transactions` rows. `npm run seed` runs the identical
wipe-and-reseed path standalone.

## HTTP API

`POST /orchestrate` is the main entry point (`{ prompt, actor? }`, `actor` defaults to
`"ops-console"`; empty/whitespace prompt returns HTTP 200 with `{ "error": "…" }`). Response
always includes `classification` (raw classifier output) plus `route`/`flow` reflecting what
actually ran, and exactly one of `flow_result` / `agent_result` populated.

`POST /orchestrate/classify` runs only the classifier and executes nothing — useful for
checking how a prompt routes before it acts.

`POST /flows/suspend-domain` (`{ domain, actor? }`) and `POST /flows/bulk-onboard`
(`{ rows: {email,name,role}[], actor? }`) call `SuspendByDomainFlow`/`BulkOnboardUsersFlow`
directly, bypassing the classifier (`orchestrator/flows.controller.ts`). Both require a
non-empty `domain`/`rows` or return `{ "error": "…" }` with HTTP 200, same convention as
`/orchestrate`.

Read-only inspection routes (no API key required, since the Anthropic client is lazy):
`GET /health`, `GET /users?q=&role=&status=&country=&city=` (`LIMIT 50`), `GET /users/:id`,
`GET /audit?limit=` (newest first, clamped 1–500).

## Configuration (env vars)

| Variable | Default | Effect |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required for `/orchestrate`; unset → 503 on that route only. |
| `ANTHROPIC_MODEL` | `claude-opus-4-8` | Used by both the agent and the classifier. |
| `MAX_TOKENS` | `4096` | Max output tokens per Mode A turn. |
| `CLASSIFIER_MAX_TOKENS` | `1024` | Max output tokens for the classifier call. Not in `.env.example`. |
| `THINKING` | `on` | Anything other than `off` enables adaptive thinking on the Mode A loop. |
| `MAX_ITERATIONS` | `12` | Hard cap on Mode A loop iterations per request. |
| `DATABASE_PATH` | `./data/useradmin.db` | Parent directory created if missing. |
| `PORT` | `3000` | Binds `0.0.0.0`. |

`THINKING=on` sends `thinking: { type: "adaptive", display: "summarized" }`, which is **only
supported on Claude Opus 4.6+ / Sonnet 4.6+ and newer**. Older models (e.g. `claude-haiku-4-5`)
reject it — the API needs `{ type: "enabled", budget_tokens: N }` instead, so if
`ANTHROPIC_MODEL` points at an older model, set `THINKING=off`. The classifier never requests
thinking; it relies on a forced tool call (`tool_choice: route_request`) for structure instead.

## Known gaps (read before extending)

- **The Mode A system prompt is currently minimal in the committed code** — the detailed
  operating guidelines (escalation thresholds, "smallest change" rule, summary style) live in
  `src/agent/agent.service.ts` near the top of the file and may be commented out or restored;
  check the current state of `SYSTEM_PROMPT` there rather than assuming either way. Tool
  schemas/descriptions carry most of the behavior regardless.
- **No tests, no lint tooling.** `jest` and `eslint` are absent from `devDependencies` despite
  the npm scripts referencing them.
- **Two Anthropic clients** (see "Shared services" above) — `AgentService` doesn't go through
  `AnthropicService`.
- **No prompt caching** — tool definitions and system prompt are re-sent uncached every loop
  turn.
- **`status: "deleted"`** is reachable only through `update_user`; there's no dedicated delete
  tool or endpoint.
- **`bulk_onboard_users` isn't reachable from natural language.** The classifier's
  `route_request` tool schema (`classifier.types.ts`) only knows about
  `suspend_users_by_domain` and `bulk_create_users_from_csv`; `bulk_onboard_users` is only
  callable via `POST /flows/bulk-onboard`. Extending the classifier to route to it would mean
  updating `ClassificationResult`/`DeterministicFlow`, the classifier's tool schema, and
  `OrchestratorService`'s dispatch — not done here.
- **The actor-role ACL has no real identity/auth behind it.** Any caller can pass any `actor`
  string (including someone else's email) — `UsersService.authorize` trusts whatever the HTTP
  caller sends. There's no session/login layer establishing who's actually calling.
- **`country`/`city` are seed-only.** No tool or endpoint lets an operator set them via
  `create_user`/`update_user`; they're only ever populated by the seed generator.
