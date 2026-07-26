# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An internal user-administration copilot (NestJS 10 + TypeScript, SQLite via `better-sqlite3`,
Claude via `@anthropic-ai/sdk`). Ops staff send natural-language requests to a single
`POST /orchestrate` endpoint; a classifier agent decides whether the request is handled by a
deterministic, code-defined flow or by a model-driven agent loop.

This repo is "Product 1 — UserAdmin Agent" out of a four-product spec described in
`PRODUCT_SPECS.md`. **Only Product 1 is implemented here.** `PRODUCT_SPECS.md` describes a
target/aspirational spec — some requirements it lists (per-transaction audit writes,
idempotent suspend, actor-role authorization checks, blast-radius ceilings) are **not yet
built**; treat that file as a design reference, not a description of current behavior. For
what's actually implemented vs. missing, trust the README's "Known gaps" section and the
code itself over `PRODUCT_SPECS.md`.

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

Everything shares one `UsersService`, and every mutation writes an `audit_log` row regardless
of which path produced it.

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
  more than 3 users match, any matched user is an admin, or risk is high — otherwise suspends
  every matched non-suspended/non-deleted account. `matched_sample` caps at 20; `matched_count`
  is the true total. With the seeded data (~350 accounts/domain) this flow **always
  escalates** — exercising the auto-suspend path requires a fresh domain with ≤3 matches, no
  admins, low/medium risk.
- **`bulk_create_users_from_csv`** — `parse_csv → create_users`. Optional header row detected
  by an `email` column (any order); without one, columns are assumed `email,name,role`.
  Handles simple double-quote wrapping but not embedded commas. Each row is created
  independently — a bad row lands in `failed` with its line number and error and does not
  abort the rest (partial success, no rollback).

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

Six tools (`src/agent/tools.ts`): `search_users` (free-text, `LIMIT 50`), `get_user`,
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

## Data model

```
users(id, email, name, role[admin|editor|viewer], status[active|suspended|deleted], created_at)
audit_log(id, actor, action, target_user_id, timestamp, details)
```

`audit_log.target_user_id` is a foreign key into `users`; `journal_mode=WAL` and
`foreign_keys=ON` are set at boot. The SQLite schema is designed to map 1:1 to Postgres.

### ⚠️ The database is wiped on every boot

`DatabaseService.onModuleInit()` (`src/database/database.service.ts:32`) runs
`createSchema() → cleanUpAllTables() → seedIfEmpty()`. `cleanUpAllTables()` deletes every row
from both tables and resets autoincrement counters, so the reseed **always** runs — IDs are
not stable across restarts. The seed generates 2500 users (roles round-robin
admin/editor/viewer; every 10th account `suspended`, every 25th `deleted`; each user gets a
**random** domain from `example.com`, `acme.com`, `globex.com`, `initech.io`, `umbrella.co`,
`hooli.com`, `wayne-enterprises.com`), so per-domain counts vary (~350 each) across boots.
`npm run seed` runs the identical wipe-and-reseed path standalone.

## HTTP API

`POST /orchestrate` is the single entry point (`{ prompt, actor? }`, `actor` defaults to
`"ops-console"`; empty/whitespace prompt returns HTTP 200 with `{ "error": "…" }`). Response
always includes `classification` (raw classifier output) plus `route`/`flow` reflecting what
actually ran, and exactly one of `flow_result` / `agent_result` populated.

`POST /orchestrate/classify` runs only the classifier and executes nothing — useful for
checking how a prompt routes before it acts.

Read-only inspection routes (no API key required, since the Anthropic client is lazy):
`GET /health`, `GET /users?q=&role=&status=` (`LIMIT 50`), `GET /users/:id`,
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
- Several guardrails described in `PRODUCT_SPECS.md` Product 1 (transactional audit writes,
  idempotent suspend, actor-role ACL enforcement, a hard suspend-count ceiling independent of
  risk escalation) are spec targets, not current behavior — don't assume they exist without
  checking the code.
