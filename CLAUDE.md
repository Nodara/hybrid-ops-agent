# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An internal user-administration **and support-desk** copilot (NestJS 10 + TypeScript, SQLite
via `better-sqlite3`, Claude via `@anthropic-ai/sdk`). Ops/support staff send natural-language
requests to a single `POST /orchestrate` endpoint; a classifier agent decides whether the
request is handled by a deterministic, code-defined flow or by a model-driven agent loop.

This repo implements "Product 1 — UserAdmin Agent" **and** "Product 2 — SupportDesk Agent" out
of a four-product spec described in `PRODUCT_SPECS.md`. **Products 3 (RevenueInvestigator) and
4 (RepoGuard) are not implemented** — `PRODUCT_SPECS.md` still describes a target/aspirational
spec for those (and for the `RouterService`/`AgentDispatchService`/`CoordinatorService`/
`DETERMINISTIC_FLOWS`-registry architecture it sketches at the top); the actual routing layer in
this codebase is `ClassifierService` → `OrchestratorService` (an explicit if-chain dispatching
to concretely injected flow classes), not a generic registry. Treat `PRODUCT_SPECS.md` as a
design reference for Products 3–4 and for architectural vocabulary, not a description of current
behavior. For what's actually implemented vs. missing, trust the README's "Known gaps" section
and the code itself over `PRODUCT_SPECS.md`.

Product 1's production-realism requirements — per-transaction audit writes, idempotent suspend,
actor-role authorization checks, and a blast-radius ceiling independent of risk escalation — are
built (see "Shared services" and "Deterministic flows" below). Product 2's are too: a
code-enforced refund policy toggleable to a prompt-only variant for A/B comparison
(`REFUND_POLICY_ENFORCEMENT`), an independent refundable-ceiling business rule, a legal/security
keyword pre-filter that runs in code before any model sees a ticket, full-thread escalation, and
(as the "context management" stretch goal) prompt caching and mid-run context compaction on the
Mode A loop.

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
      │              → { route, flow, domain, csv_text, ticket_id, tool_sequence, reasoning }
      │
      ├── ticket_id extracted and non-null? ── universal pre-dispatch guardrail:
      │     TicketsService.checkLegalOrSecurityFlags(ticket_id) runs FIRST, before either
      │     branch below sees the ticket — flagged → escalate immediately, regardless of route.
      │
      ├── route = "deterministic" AND required param present
      │     ├── suspend_users_by_domain    → SuspendByDomainFlow
      │     ├── bulk_create_users_from_csv → BulkCreateUsersFlow
      │     ├── resolve_billing_ticket     → ResolveBillingTicketFlow   (Product 2)
      │     └── triage_ticket              → TriageTicketFlow           (Product 2)
      │
      └── route = "model_driven"  (or deterministic flow missing its param)
            └── AgentService — hand-rolled tool loop, 12 tools (6 UserAdmin + 6 SupportDesk
                merged into one TOOL_DEFINITIONS array), tool_choice: auto, prompt caching +
                optional context compaction
```

`POST /flows/suspend-domain`, `POST /flows/bulk-onboard`, `POST /flows/resolve-billing-ticket`,
and `POST /flows/triage-ticket` (`orchestrator/flows.controller.ts`) call their flows directly,
bypassing the classifier entirely — for callers that already know which flow they want.
`bulk_onboard_users` is reachable **only** through its direct endpoint; the classifier still
routes natural-language CSV requests to `bulk_create_users_from_csv`, not to
`bulk_onboard_users`.

There is no generic flow registry — `OrchestratorService` constructor-injects each flow by
concrete class and dispatches via an explicit `if` chain on `classification.flow`. Adding a
flow means adding a `DeterministicFlow` value, a classifier schema/prompt update, and a new `if`
branch, same as the four that already exist.

Product 1 and Product 2 share one identity table (`users`) and one `UsersService`; every
mutation (Product 1's user CRUD, Product 2's refunds) writes an `audit_log` row regardless of
which path produced it, in the same DB transaction as the mutation (see "Shared services").

**Safety rule (`orchestrator/orchestrator.service.ts`):** if the classifier picks a
deterministic flow but the required parameter (`domain` / `csv_text` / `ticket_id`) is missing
or blank, the orchestrator does **not** guess — it logs a warning and falls back to the
model-driven engine, which can ask the operator for clarification. The response's top-level
`route` always reports what *actually* ran, which may differ from `classification.route` (this
is also how the universal ticket pre-filter above surfaces: it can report `route:
"deterministic"` with an escalated result even when `classification.route` was
`"model_driven"`).

### Why the classifier/deterministic split exists

Suspending an entire email domain, bulk-creating users from CSV, and resolving a billing
ticket's refund decision are common, high-volume, and dangerous enough that control flow
shouldn't be left to a model — they run as fixed step sequences in code. Everything else
(single-user lookups, updates, KB questions, ambiguous or multi-step requests) goes to the
model-driven engine, which now carries both domains' tools simultaneously.

### Disambiguating UserAdmin from SupportDesk requests

A request that references a specific support ticket (by id, or "this ticket") routes to
`resolve_billing_ticket`/`triage_ticket` even if it also mentions user-administration language
like "suspend" (e.g. "handle ticket #42, the customer wants a refund or they'll suspend their
account" is `resolve_billing_ticket`, not `suspend_users_by_domain`) — this disambiguation is
spelled out explicitly in the classifier's system prompt (`classifier.service.ts`). A bare
domain/user suspension request with no ticket reference stays a UserAdmin flow.

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
- **`resolve_billing_ticket`** (`flows/resolve-billing-ticket.flow.ts`, Product 2) —
  `legal_security_prefilter → classify → fetch_customer_and_subscription →
  check_policy_and_refund`. The first (and only) `async` flow in the codebase, since `classify`
  is an LLM call (forced-tool, `ticket-classifiers.ts`) — every other flow is synchronous
  better-sqlite3 I/O. The legal/security keyword check runs in code **before** the classify
  step ever sees the ticket; if flagged, escalates immediately with the full thread packaged in,
  no model call made. Otherwise classifies refund intent/amount, fetches the customer +
  subscription, and calls `RefundsService.issueRefund` — the single source of truth for both
  refund business rules, shared with Mode A's `issue_refund` tool so the two paths can never
  diverge in policy logic. A rejected refund (policy violation, over the refundable ceiling, or
  an unauthorized actor) is caught and turned into an escalation rather than propagated as an
  error. `decision` is one of `refunded`, `escalated`, `replied_no_refund`.
- **`triage_ticket`** (`flows/triage-ticket.flow.ts`, Product 2) — cheap first-pass ticket
  classification (`legal_security_prefilter → classify_category → handoff_or_escalate`),
  demonstrating the "cheap classifier before the expensive path" pattern: a forced-tool call
  categorizes the ticket as `billing`/`technical`/`legal`/`other` for a fraction of the tokens a
  full resolution would cost. `billing` hands off to `resolve_billing_ticket`; `legal` escalates
  without ever running the billing flow; `technical`/`other` have no deterministic handler yet
  and are returned as-is for Mode A or a human.

### Product 2 guardrails (`src/support-desk/`)

- **`legal-keyword-filter.ts`** — pure function, word-boundary regex matching (not naive
  substring — an earlier substring-based version false-positived on "sue" inside "**iss-ue**",
  since fixed) against ticket subject + body + full thread. Independent of, and enforced
  *before*, the dollar-amount policy — a ticket can be blocked by keywords even if the refund
  amount would otherwise be auto-approved. Invoked from three places so it can't be bypassed by
  routing choice: `OrchestratorService`'s universal pre-dispatch guardrail (any route),
  `ResolveBillingTicketFlow`/`TriageTicketFlow` (deterministic route), and Mode A's `get_ticket`
  tool, which withholds ticket body/thread from the model entirely when flagged.
- **`refund-policy.ts`** — two independent, pure business rules: `evaluateRefundPolicy`
  (dollar-threshold autonomy policy — `REFUND_POLICY = { autoApproveMaxCents: 5000,
  requiresApprovalMaxCents: 20000 }`, "policy as data" per the brief, not prompt text) and
  `computeRefundableCeilingCents` (remaining-term proration from `mrr_cents`/`renewed_at` over a
  hardcoded 30-day billing period — always enforced, never gated by the policy-enforcement flag,
  since it's a distinct business rule).
- **`refunds.service.ts`** — `RefundsService.issueRefund` is where both rules above are actually
  enforced, plus actor-role authorization (`editor`/`admin` only, reusing
  `UsersService.resolveActorRole`) and the audit/ledger-mirror writes. Reads
  `REFUND_POLICY_ENFORCEMENT` **once** at construction: `"code_enforced"` (default) rejects a
  policy-violating refund as a tool/flow error; `"prompt_only"` skips that check entirely (the
  policy text still exists only in the Mode A system prompt) so the identical adversarial ticket
  can be run through both and the difference recorded — this pairing is the single most
  exam-relevant artifact in the SupportDesk build. The refundable-ceiling check is **not**
  gated by this flag.

### Model-driven engine — Mode A (`src/agent/agent.service.ts`)

Hand-rolled tool loop (not the SDK's agent/tool-runner helper) so it can: log every turn
(`agent/turn-logger.service.ts` — tool calls with arguments, `stop_reason`, token counts, also
echoed to stdout); terminate cleanly when the model calls `escalate_to_human`; cap iterations at
`MAX_ITERATIONS`; and (optionally) compact long-running ticket threads. The full assistant turn
(including thinking blocks) is pushed back onto `messages` each iteration so the model retains
its reasoning across tool calls; parallel tool calls execute together and return as
`tool_result` blocks in a single user turn. `escalate_to_human` is checked **before** any tools
execute in that turn — if the model calls it alongside other tools, those other tools do not run
and the loop breaks immediately with no `tool_result` returned.

**Twelve tools, one merged array** (`src/agent/tools.ts` + `src/agent/tools-supportdesk.ts`,
concatenated into `ALL_TOOLS` in `agent.service.ts`) — Product 1 and Product 2 tools are
dispatched from the same loop via `USER_ADMIN_TOOL_NAMES.has(name)` to pick which executor
handles a given tool call, so one agent reasons over both domains with `tool_choice: auto`:

- UserAdmin (6): `search_users` (free-text, optional `role`
  [admin/editor/viewer/customer]/`status`/`country`/`city` filters, `LIMIT 50` — e.g. a
  customer lookup by email is `search_users({ query: email, role: "customer" })`), `get_user`,
  `create_user` (email format validated in code via `isValidEmail` in `user.types.ts`, not
  described to the model; email lowercased; uniqueness enforced), `update_user` (partial,
  rejects empty field set), `suspend_user` (`reason` required in the tool's `input_schema`
  itself, not just prose), `escalate_to_human` (terminates the loop; `risk_level` ∈
  low/medium/high/critical; `ticket_id`/`full_thread` optionally set when the escalation
  concerns a SupportDesk ticket — see below).
- SupportDesk (6): `search_kb`, `get_customer` (thin wrapper over `search_users(email,
  "customer")`), `get_subscription`, `get_ticket` (fetches a ticket + full thread — **but
  withholds body/thread entirely when `checkLegalOrSecurityFlags` reports it flagged**, so the
  guardrail can't be reasoned around by an agent that already has the content in context; the
  model is told to call `escalate_to_human` instead), `issue_refund` (delegates to
  `RefundsService.issueRefund` — same two business rules and actor authorization as the
  deterministic flow), `send_reply`.

Invalid input is returned to the model as an `is_error` tool result so it can self-correct
rather than crashing the loop. `escalate_to_human`, when `ticket_id` is set, also marks that
ticket `escalated` via `TicketsService.updateStatus` — escalation always preserves the full
message thread (`full_thread`), not a one-line note, since a human picking up the ticket needs
the history.

### Context management (Product 2's "weak domain" stretch goal)

- **Prompt caching:** the system prompt (as a single cached `TextBlockParam`) and the last tool
  definition in `ALL_TOOLS` both carry `cache_control: { type: "ephemeral" }` — the standard
  Anthropic breakpoint pattern. Verified live: `cache_creation_input_tokens` populates on turn
  1, `cache_read_input_tokens` on every subsequent turn (already captured by `TurnLog`; no
  logging changes were needed, only the request-construction change).
- **Compaction:** off by default (`COMPACTION_ENABLED`). Past a turn count or token threshold
  (and a cooldown since the last compaction), `AgentService` makes one extra no-tools Claude
  call to summarize everything except the most recent N turn-pairs, then replaces the older
  history with a synthetic assistant-summary/user-acknowledgment pair
  (`src/agent/compaction.ts` — kept in its own file, same spirit as `risk-assessment.ts`, so the
  message-array surgery is testable in isolation from the loop). Preserves the strict
  user/assistant role alternation the Messages API requires. Verified live across a real 5-turn
  Mode A run with aggressive thresholds: 3 compaction passes fired, each logged in `TurnLog` as
  `compaction: { summarized_pairs }`, with no role-alternation errors and a coherent final
  answer. The spec's own before/after token-cost comparison across a 25+ message thread is a
  manual exercise left to whoever's running the experiment — the mechanism doesn't script that
  comparison itself.

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
    applies uniformly to agent tool calls and deterministic flows. `resolveActorRole` is public
    so other domains can reuse the same lookup — `RefundsService` does (see below) rather than
    duplicating the SQL query.
- `TicketsService`/`SubscriptionsService`/`RefundsService`/`KbService` (`src/support-desk/`) are
  Product 2's equivalent of `UsersService`: constructor-inject `DatabaseService`, throw a
  dedicated `*OperationError` on validation/lookup failure, and (for `RefundsService`) wrap the
  refund insert + ledger mirror + audit write in one transaction, same `inTransaction`/
  `runAtomically` pattern as `UsersService`. `RefundsService` additionally gates on actor role
  (`editor`/`admin` only — money movement, so treated at least as strictly as `suspend_user`)
  and reads the `REFUND_POLICY_ENFORCEMENT` feature flag once at construction.

## Data model

```
users(id, email, name, role[admin|editor|viewer|customer], status[active|suspended|deleted],
      country, city, created_at)
audit_log(id, actor, action, target_user_id, timestamp, details)
transactions(id, user_id, type[subscription_charge|refund|balance_credit|balance_debit],
             amount_cents, currency, created_at, metadata)

-- Product 2 (SupportDesk) — a ticket's user IS a users row with role='customer',
-- not a separate customers table.
subscriptions(id, user_id, plan[starter|pro|enterprise], mrr_cents,
              status[active|canceled|past_due], renewed_at)
tickets(id, user_id, subject, body, status[open|resolved|escalated], created_at)
ticket_messages(id, ticket_id, sender[customer|agent|human], body, created_at)
refunds(id, subscription_id, amount_cents, reason, issued_by, approved_by, created_at)
kb_articles(id, title, body, keywords)
```

`audit_log.target_user_id`, `transactions.user_id`, `subscriptions.user_id`, `tickets.user_id`,
`ticket_messages.ticket_id`, and `refunds.subscription_id` are all foreign keys;
`journal_mode=WAL` and `foreign_keys=ON` are set at boot. The SQLite schema is designed to map
1:1 to Postgres — there is no migration framework, so every table is created via one
`CREATE TABLE IF NOT EXISTS` block in `DatabaseService.createSchema()`. `country`/`city` are
nullable and only set by the seed generator today — no tool or endpoint lets an operator set
them on create/update. Every `issue_refund` call (whichever path it came through) writes a
mirrored `transactions` row (`type='refund'`, `metadata.refund_id`) so a future Product 3 could
read refunds without joining through Product 2's schema — `transactions` itself still isn't read
by anything in this repo yet.

### ⚠️ The database is wiped on every boot

`DatabaseService.onModuleInit()` (`src/database/database.service.ts:21`) runs
`createSchema() → cleanUpAllTables() → seedIfEmpty()`. `cleanUpAllTables()` deletes every row
from every table (child-before-parent: `refunds`/`ticket_messages` before
`subscriptions`/`tickets` before `users`) and resets autoincrement counters, so the reseed
**always** runs — IDs are not stable across restarts. The seed generates 2500 users (roles
round-robin admin/editor/viewer/customer; every 10th account `suspended`, every 25th `deleted`;
each user gets a **random** domain from `example.com`, `acme.com`, `globex.com`, `initech.io`,
`umbrella.co`, `hooli.com`, `wayne-enterprises.com`, and a **random** country/city pair from a
fixed list), so per-domain counts vary (~350 each) across boots. Every seeded `customer` account
gets 0–3 sample `transactions` rows, plus (deterministically, keyed off a stable per-customer
number rather than `Math.random()`) one `subscriptions` row, a ticket + 1–2 messages for
roughly 1-in-5 customers, and a pre-existing refund (mirrored into `transactions`) for roughly
1-in-20. Five static `kb_articles` are seeded unconditionally. Three **fixed, non-random** demo
users/tickets are also seeded every boot for exercising Product 2's guardrails reproducibly:
`demo.dollarpolicy@example.com` (a $120 refund request — within the refundable ceiling, above
`autoApproveMaxCents`, no legal keywords: isolates the dollar-policy layer),
`demo.keywordfilter@example.com` (the spec's literal "refund my $500 or I'll escalate this to
legal" — demonstrates the keyword layer, which fires in *both* enforcement modes), and
`demo.compaction@example.com` (a 30-message alternating thread for exercising
`COMPACTION_ENABLED`). `npm run seed` runs the identical wipe-and-reseed path standalone.

## HTTP API

`POST /orchestrate` is the main entry point (`{ prompt, actor? }`, `actor` defaults to
`"ops-console"`; empty/whitespace prompt returns HTTP 200 with `{ "error": "…" }`). Response
always includes `classification` (raw classifier output) plus `route`/`flow` reflecting what
actually ran, and exactly one of `flow_result` / `agent_result` populated.

`POST /orchestrate/classify` runs only the classifier and executes nothing — useful for
checking how a prompt routes before it acts.

`POST /flows/suspend-domain` (`{ domain, actor? }`), `POST /flows/bulk-onboard`
(`{ rows: {email,name,role}[], actor? }`), `POST /flows/resolve-billing-ticket`
(`{ ticket_id, actor? }`), and `POST /flows/triage-ticket` (`{ ticket_id, actor? }`) call their
flows directly, bypassing the classifier (`orchestrator/flows.controller.ts`). All require a
valid, non-empty `domain`/`rows`/numeric `ticket_id` or return `{ "error": "…" }` with HTTP 200,
same convention as `/orchestrate`. The two ticket-flow endpoints call Claude (the `classify`
step), so — unlike the two Product 1 flow endpoints — they need `ANTHROPIC_API_KEY` set.

Read-only inspection routes (no API key required, since the Anthropic client is lazy):
`GET /health`, `GET /users?q=&role=&status=&country=&city=` (`LIMIT 50`), `GET /users/:id`,
`GET /audit?limit=` (newest first, clamped 1–500), `GET /tickets/:id`,
`GET /tickets/:id/messages`, `GET /subscriptions/:id`, `GET /subscriptions?user_id=`.

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
| `REFUND_POLICY_ENFORCEMENT` | `code_enforced` | `code_enforced` rejects refunds violating `REFUND_POLICY` in code; `prompt_only` skips that check (policy is prompt-text only) for the paired adversarial-ticket comparison. Read once by `RefundsService`. |
| `COMPACTION_ENABLED` | `off` | `on` enables the Mode A context-compaction pass. |
| `COMPACTION_TURN_THRESHOLD` | `20` | Compact once the loop reaches this turn count. |
| `COMPACTION_TOKEN_THRESHOLD` | `60000` | Or once a turn's `input_tokens` exceeds this, whichever comes first. |
| `COMPACTION_KEEP_RECENT_TURNS` | `4` | How many recent turn-pairs survive a compaction pass uncompacted; also the cooldown before another can fire. |

Note that nothing in this app loads `.env` itself (no `dotenv` import in `main.ts`). Docker
Compose reads `.env` on its own for `${VAR}` substitution in `docker-compose.yml`, so `docker
compose up` picks it up automatically — but running `npm run start:dev`/`npm run seed` locally
does not read `.env` at all; export the variables into the shell yourself first (e.g. `set -a &&
source .env && set +a`).

`THINKING=on` sends `thinking: { type: "adaptive", display: "summarized" }`, which is **only
supported on Claude Opus 4.6+ / Sonnet 4.6+ and newer**. Older models (e.g. `claude-haiku-4-5`)
reject it — the API needs `{ type: "enabled", budget_tokens: N }` instead, so if
`ANTHROPIC_MODEL` points at an older model, set `THINKING=off`. The classifier never requests
thinking; it relies on a forced tool call (`tool_choice: route_request`) for structure instead.

## Known gaps (read before extending)

- **No tests, no lint tooling.** `jest` and `eslint` are absent from `devDependencies` despite
  the npm scripts referencing them.
- **Two Anthropic clients, now with a third correct example alongside them.** `AgentService`
  still builds its own separate client instead of going through `AnthropicService` — unchanged
  by the Product 2 work. `ClassifierService` and the new `ticket-classifiers.ts` helpers both
  correctly inject/use `AnthropicService`, so the shared-client pattern is followed by two of
  the three LLM-calling call sites, not one.
- **`status: "deleted"`** is reachable only through `update_user`; there's no dedicated delete
  tool or endpoint.
- **`bulk_onboard_users` isn't reachable from natural language.** The classifier's
  `route_request` tool schema (`classifier.types.ts`) knows about `suspend_users_by_domain`,
  `bulk_create_users_from_csv`, `resolve_billing_ticket`, and `triage_ticket` — `bulk_onboard_users`
  is still only callable via `POST /flows/bulk-onboard`.
- **The actor-role ACL has no real identity/auth behind it.** Any caller can pass any `actor`
  string (including someone else's email) — `UsersService.authorize`/`RefundsService`'s refund
  gate both trust whatever the HTTP caller sends. There's no session/login layer establishing
  who's actually calling. An actor string that doesn't match any user's email (e.g. the default
  `"ops-console"`) resolves to `admin` for both user CRUD and refunds — a deliberate consistency
  choice, not a fix, since it means the same "trusted internal caller" fallback now also applies
  to money movement.
- **`country`/`city` are seed-only.** No tool or endpoint lets an operator set them via
  `create_user`/`update_user`; they're only ever populated by the seed generator.
- **`search_kb` does naive substring matching**, not per-word/fuzzy search — a multi-word query
  like `"export data"` won't match an article unless that exact phrase appears verbatim (the
  seeded "Exporting Your Data" article, keyworded `export,data,csv,download,gdpr`, is missed by
  that two-word query even though either word alone would hit it). Same simplicity tradeoff as
  `UsersService.search`'s `LIKE` matching, just more noticeable with prose queries.
- **`triage_ticket` has no deterministic handler for `technical`/`other` categories** — those
  are returned as classified-but-unhandled for Mode A or a human to pick up; only `billing`
  (hands off to `resolve_billing_ticket`) and `legal` (escalates) are actually resolved
  deterministically.
- **The compaction summarization call isn't itself turn-logged** — it's a separate,
  un-instrumented Claude call inside `AgentService.summarizeForCompaction`; only the fact that a
  compaction happened (`TurnLog.compaction.summarized_pairs`) is recorded, not that call's own
  token usage.
