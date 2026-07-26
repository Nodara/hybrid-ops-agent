# Hybrid Ops Agent — UserAdmin + SupportDesk

An internal user-administration **and support-desk** copilot. Ops/support staff send
natural-language requests to a single endpoint; a **classifier agent** decides whether the
request is handled by a **deterministic, code-defined flow** or by a **model-driven agent
loop**.

This repo implements two of the four products described in `PRODUCT_SPECS.md`:
**Product 1 — UserAdmin Agent** (user CRUD, domain-wide suspension, bulk onboarding) and
**Product 2 — SupportDesk Agent** (ticket triage, refunds with policy enforcement, a
knowledge base). Products 3 (RevenueInvestigator) and 4 (RepoGuard) are not built — treat
`PRODUCT_SPECS.md` as a design reference for those, and for the `RouterService`/
`AgentDispatchService`/registry architecture it sketches, which this codebase doesn't
actually use (see [Architecture](#architecture)).

- **Framework:** NestJS 10
- **Store:** SQLite via `better-sqlite3` (schema maps 1:1 to Postgres — see `docker-compose.yml`)
- **Model:** Claude, via `@anthropic-ai/sdk` — configured with `ANTHROPIC_MODEL`
- **Runtime:** Docker Compose, or Node 22+ locally

## Architecture

```
POST /orchestrate
      │
      ▼
ClassifierService ── one Claude call, tool_choice forced to `route_request`
      │              → { route, flow, domain, csv_text, ticket_id, tool_sequence, reasoning }
      │
      ├── ticket_id extracted? ── universal pre-dispatch guardrail: the legal/security
      │     keyword filter runs on that ticket FIRST, before either branch below sees it —
      │     flagged → escalate immediately, regardless of route.
      │
      ├── route = "deterministic" AND required param present
      │     ├── suspend_users_by_domain    → SuspendByDomainFlow
      │     ├── bulk_create_users_from_csv → BulkCreateUsersFlow
      │     ├── resolve_billing_ticket     → ResolveBillingTicketFlow   (Product 2)
      │     └── triage_ticket              → TriageTicketFlow           (Product 2)
      │
      └── route = "model_driven"  (or deterministic flow missing its param)
            └── AgentService — hand-rolled tool loop, 12 tools (UserAdmin + SupportDesk
                merged into one array), tool_choice: auto, prompt caching + optional
                context compaction
```

There is no generic flow registry — `OrchestratorService` constructor-injects each flow by
concrete class and dispatches via an explicit `if` chain on `classification.flow`. Four flows
also have direct entry points that skip the classifier entirely — `POST /flows/suspend-domain`,
`POST /flows/bulk-onboard`, `POST /flows/resolve-billing-ticket`, and
`POST /flows/triage-ticket` — for callers that already know which workflow they want (see
[HTTP API](#http-api)).

Product 1 and Product 2 share one identity table (`users`) and one `UsersService`; every
mutation — Product 1's user CRUD, Product 2's refunds — writes an `audit_log` row regardless of
which path produced it, in the same DB transaction as the mutation.

### Why a classifier

Some operations are common, high-volume, and dangerous enough that we don't want a model
choosing the control flow: suspending an entire email domain, bulk-creating users from CSV,
and resolving a billing ticket's refund decision. Those run as fixed step sequences in code.
Everything else — single-user lookups, updates, KB questions, ambiguous or multi-step
requests — goes to the model, which now carries both domains' tools simultaneously.

**Safety rule:** if the classifier picks a deterministic flow but the required parameter
is missing or blank, the orchestrator does **not** guess. It logs a warning and falls
back to the model-driven engine, which can ask the operator for clarification
(`orchestrator.service.ts`). The response always reports the route that *actually*
ran, which may differ from the classifier's `classification.route` — this is also how the
ticket pre-filter above surfaces: it can report `route: "deterministic"` with an escalated
result even when the classifier itself picked `"model_driven"`.

### Disambiguating UserAdmin from SupportDesk

A request naming a specific support ticket routes to `resolve_billing_ticket`/`triage_ticket`
even if it also uses user-administration language like "suspend" — e.g. "handle ticket #42,
the customer wants a refund or they'll suspend their account" is `resolve_billing_ticket`, not
`suspend_users_by_domain`. This disambiguation is spelled out explicitly in the classifier's
system prompt. A bare domain/user suspension request with no ticket reference stays a
UserAdmin flow.

## Deterministic flows

### `suspend_users_by_domain`

Steps: `find_users_by_domain → assess_risk → escalate_or_suspend`.

1. **Find.** The raw domain is normalized (`@Acme.com`, `user@acme.com`, `mailto:…`,
   trailing slashes → `acme.com`), then matched with `lower(email) LIKE '%@domain'`.
   No `LIMIT` — the flow needs the complete set to assess risk.
2. **Assess risk.** A pure function (`flows/risk-assessment.ts`) — no model call:

   | Signal | Score |
   |---|---|
   | Each admin in scope | +40 |
   | Each editor in scope | +10 |
   | Blast radius | `min(matches, 25) × 2` |
   | Currently-active accounts | `+ min(active, 20)` |

   Level: `≥ 70` → high, `≥ 35` → medium, else low.
3. **Escalate or suspend.** Escalates to a human if **any** of: more than **3** users
   match (`MAX_AUTO_SUSPEND`), **any** matched user is an admin, risk level is **high**, or
   more than **50** users match (`MAX_SUSPEND_PER_INVOCATION` — a hard ceiling checked
   independently of the other three, so it still applies even if `MAX_AUTO_SUSPEND` is ever
   raised). Otherwise it suspends every matched non-deleted account. Already-suspended
   accounts still go through `suspend()` — it's idempotent, so the row update no-ops but the
   attempt is still audited.

`decision` is one of `escalated`, `suspended`, or `no_matches`. `matched_sample` is
capped at 20 users; `matched_count` is the true total.

> With the seeded data every domain has roughly 350 accounts, so this flow **always
> escalates**. To exercise the auto-suspend path you need a domain with ≤ 3 matches, no
> admins, and low/medium risk — create three viewers on a fresh domain first.

### `bulk_create_users_from_csv`

Steps: `parse_csv → create_users`.

Accepts an optional header row in any column order (detected by looking for an `email`
column); with no header, columns are assumed to be `email,name,role`. Handles simple
double-quote wrapping but **not** embedded commas. Each row is created independently —
a bad row lands in `failed` with its line number and error, and does not abort the rest
(partial success). Reachable via `POST /orchestrate` or the model-driven agent; not exposed
as its own `/flows/*` route.

### `bulk_onboard_users`

Steps: `validate_rows → create_valid_rows`. Reachable only via `POST /flows/bulk-onboard` —
the classifier doesn't route to it.

Takes a `rows: {email,name,role}[]` array directly (no CSV parsing). Two-phase:

1. **Validate everything first.** Every row is checked — email format, valid role,
   duplicate against *other rows in the same batch*, and duplicate against the DB — before
   any writes happen. A batch over **500** rows is rejected outright (`outcome: "rejected"`)
   rather than silently truncated.
2. **Write the valid rows atomically.** Every row that passed validation is created inside
   **one transaction**: they all commit together, or (if something unexpected fails
   mid-write) none do and the whole batch rolls back.

The response is a per-row array: `{ line, email, status: "created" | "skipped", reason?,
user? }`, where `reason` is one of `invalid_format`, `invalid_role`, `duplicate_in_batch`,
`duplicate_in_db`, or `write_failed`.

### `resolve_billing_ticket` (Product 2)

Steps: `legal_security_prefilter → classify → fetch_customer_and_subscription →
check_policy_and_refund`.

The first (and only) `async` flow in the codebase — the `classify` step is a forced-tool
Claude call, unlike every other flow, which is synchronous better-sqlite3 I/O.

1. **Legal/security pre-filter, in code, before anything else.** If the ticket's subject,
   body, or thread matches a legal/security keyword, the flow escalates immediately — the
   `classify` step never runs and no model call touches the ticket content.
2. **Classify.** A forced-tool call decides whether the customer wants a refund and, if so,
   how much.
3. **Fetch customer + subscription.**
4. **Check policy and refund.** Delegates to `RefundsService.issueRefund` — the same code path
   Mode A's `issue_refund` tool uses, so the two entry points can never diverge in policy
   logic. A rejected refund (dollar policy, refundable ceiling, or an unauthorized actor) is
   caught and turned into an escalation, not propagated as an error.

`decision` is one of `refunded`, `escalated` (with the full thread packaged into
`escalation.full_thread`), or `replied_no_refund`.

### `triage_ticket` (Product 2)

Steps: `legal_security_prefilter → classify_category → handoff_or_escalate`. A cheap
first-pass classifier — "cheap tier before the expensive path" — categorizes a ticket as
`billing`/`technical`/`legal`/`other` for a fraction of the tokens a full resolution costs.
`billing` hands off to `resolve_billing_ticket`; `legal` escalates without ever running the
billing flow; `technical`/`other` have no deterministic handler yet and come back
classified-but-unhandled for Mode A or a human.

### Product 2 guardrails

- **Legal/security keyword filter** (`support-desk/legal-keyword-filter.ts`) — a pure function,
  word-boundary regex matching against ticket subject + body + thread. Independent of, and
  enforced *before*, the dollar-amount policy below. Invoked from three places so it can't be
  routed around: the orchestrator's universal pre-dispatch guardrail, both ticket flows, and
  Mode A's `get_ticket` tool (which withholds the ticket body/thread from the model entirely
  once flagged).
- **Refund policy — two independent business rules**, both in `support-desk/refund-policy.ts`:
  - `evaluateRefundPolicy` — the dollar-threshold autonomy policy, stored as data
    (`REFUND_POLICY = { autoApproveMaxCents: 5000, requiresApprovalMaxCents: 20000 }`), not
    prompt text.
  - `computeRefundableCeilingCents` — remaining-term proration from `mrr_cents`/`renewed_at`
    over a hardcoded 30-day period. Always enforced, never gated by the flag below.
- **`REFUND_POLICY_ENFORCEMENT` feature flag**, read once by `RefundsService`: `code_enforced`
  (default) rejects a policy-violating refund in code; `prompt_only` skips that check entirely
  (the policy still exists only as prose in the Mode A system prompt), so you can run the
  identical adversarial ticket through both and record the difference — see
  [Things to try](#things-to-try).

## Mode A — model-driven

`AgentService` is given all twelve tools (both domains, one merged array) with
`tool_choice: auto` and runs the tool loop by hand so it can:

- **log every turn** — tools called with their arguments, `stop_reason`, and token counts
  (`agent/turn-logger.service.ts`);
- **terminate cleanly** when the model calls `escalate_to_human`;
- **cap iterations** at `MAX_ITERATIONS`; and
- **optionally compact** long-running ticket threads (see [Context management](#context-management)).

The full assistant turn — including thinking blocks — is pushed back onto `messages` each
iteration, so the model keeps its reasoning across tool calls. Parallel tool calls are
executed and returned as `tool_result` blocks in a single user turn.

> `escalate_to_human` is checked **before** any tools execute. If the model calls it
> alongside other tools in the same turn, those other tools do not run and no
> `tool_result` is returned — the loop breaks immediately.

### Tools (12)

`src/agent/tools.ts` (UserAdmin) and `src/agent/tools-supportdesk.ts` (SupportDesk) are
concatenated into one `ALL_TOOLS` array; the loop picks which executor handles a given tool
call by name, so one agent reasons over both domains.

**UserAdmin (6)**

| Tool | Notes |
|---|---|
| `search_users(query, role?, status?, country?, city?)` | Free-text against email and name; optional exact-match `role`/`status`/`country`/`city` filters. `role` includes `customer` (e.g. a customer lookup by email is `search_users({ query: email, role: "customer" })`). Empty query matches all. **`LIMIT 50`.** |
| `get_user(user_id)` | Full record. Errors if not found. |
| `create_user(email, name, role)` | Email format validated **in code** (`user.types.ts` → `isValidEmail`), not described in the prompt. Email is lowercased; uniqueness enforced. `role` ∈ admin/editor/viewer. |
| `update_user(user_id, fields)` | Partial update over `email`/`name`/`role`/`status`. Rejects an empty field set. |
| `suspend_user(user_id, reason)` | `reason` is **required in the `input_schema`**, not just in prose. Idempotent — re-suspending an already-suspended user no-ops the row but still audits the attempt. |
| `escalate_to_human(summary, risk_level, ticket_id?, full_thread?)` | **Terminates the loop.** `risk_level` ∈ low/medium/high/critical. `ticket_id`/`full_thread` are set when the escalation concerns a SupportDesk ticket — the flow's own escalations also always package the full thread, not a one-line note. |

**SupportDesk (6)**

| Tool | Notes |
|---|---|
| `search_kb(query)` | Substring match (not fuzzy/per-word) against KB article title/body/keywords. |
| `get_customer(email)` | Thin wrapper over `search_users(email, "customer")`. |
| `get_subscription(user_id)` | The customer's current subscription. |
| `get_ticket(ticket_id)` | Fetches the ticket + full thread — **unless** the legal/security filter flags it, in which case the body/thread are withheld entirely and the model is told to call `escalate_to_human` instead. This is what makes the guardrail unbypassable: the model can't reason around content it never receives. |
| `issue_refund(subscription_id, amount_cents, reason, approval_flag?)` | Delegates to `RefundsService.issueRefund` — same refundable-ceiling + dollar-policy checks and actor authorization as the deterministic flow. Rejects (as a tool error) rather than silently adjusting the amount. |
| `send_reply(ticket_id, body)` | Adds an `agent`-sender message to the ticket thread. |

Invalid input (bad email, missing user/ticket, duplicate address, bad role, policy-violating
refund) is returned to the model as an `is_error` tool result so it can correct itself or
explain the problem rather than crashing the loop. So is an authorization failure —
`create_user`/`update_user`/`suspend_user`/`issue_refund` all check the calling `actor`'s role
first and return an `is_error` result if it's not permitted, rather than mutating anything.

### Actor-role ACL

`UsersService` resolves every mutating call's `actor` string to a role before doing anything
else: a match against a known `users.email` uses that user's real role; anything else
(including the default `"ops-console"` label) is treated as a trusted internal caller and
resolves to `admin`. Permission matrix:

| Role | `create_user` | `update_user` | `suspend_user` | `issue_refund` |
|---|:---:|:---:|:---:|:---:|
| `viewer` | ✗ | ✗ | ✗ | ✗ |
| `editor` | ✓ | ✓ | ✗ | ✓ |
| `admin` | ✓ | ✓ | ✓ | ✓ |

`RefundsService` reuses `UsersService.resolveActorRole` (made public for this) rather than
duplicating the lookup — money movement is gated at least as strictly as `suspend_user`, since
an unknown actor still resolves to the trusted `admin` fallback either way. Enforced inside the
service layer itself, not the tool prompt/schema — so it applies uniformly whether the call
came from the agent loop or a deterministic flow. There's no real session/login layer behind
this: any caller can pass any `actor` string, including someone else's email.

## Context management

Product 2's stretch goal, built on top of the same `AgentService` loop:

- **Prompt caching.** The system prompt and the last tool definition both carry
  `cache_control: { type: "ephemeral" }`. Verified live: `cache_creation_input_tokens`
  populates on turn 1, `cache_read_input_tokens` on every turn after.
- **Compaction**, off by default (`COMPACTION_ENABLED=off`). Past a configurable turn count or
  token threshold, `AgentService` makes one extra no-tools Claude call to summarize everything
  except the most recent few turn-pairs, then splices in a synthetic
  assistant-summary/user-acknowledgment pair in place of the older history
  (`agent/compaction.ts`) — preserving the strict role alternation the Messages API requires. A
  compaction event is recorded on the relevant `TurnLog` as `compaction: { summarized_pairs }`.
  Verified live across a real multi-turn run: 3 compaction passes fired with aggressive
  thresholds, no role-alternation errors, and a coherent final answer. The mechanism doesn't
  script the before/after token-cost comparison itself — that's a manual exercise once you've
  got a long enough ticket thread to run it against.

## Data model

```
users(id, email, name, role[admin|editor|viewer|customer],
      status[active|suspended|deleted], country, city, created_at)
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

All the obvious foreign keys are declared (`tickets.user_id`, `ticket_messages.ticket_id`,
`refunds.subscription_id`, etc.); `journal_mode=WAL` and `foreign_keys=ON` are set at boot.
`country`/`city` are nullable and only ever populated by the seed generator — no tool or
endpoint sets them today. Every `issue_refund` call also writes a mirrored `transactions` row
(`type='refund'`, `metadata.refund_id`) so a future Product 3 could read refunds without
joining through Product 2's schema — `transactions` itself still isn't read by anything in this
codebase yet.

### ⚠️ The database is wiped on every boot

`DatabaseService.onModuleInit()` runs `createSchema() → cleanUpAllTables() → seedIfEmpty()`
(`database/database.service.ts:21`). `cleanUpAllTables()` deletes every row from every table
(child-before-parent — `refunds`/`ticket_messages` before `subscriptions`/`tickets` before
`users`) and resets the autoincrement counters, so **the reseed always runs** and IDs are not
stable across restarts.

The seed generates **2500** users: names cycle through fixed first/last name pools, roles
round-robin across admin/editor/viewer/customer, every 10th account is `suspended` and every
25th is `deleted`, each user is assigned a **random** domain from:

```
example.com  acme.com  globex.com  initech.io
umbrella.co  hooli.com  wayne-enterprises.com
```

and a **random** `(country, city)` pair from a fixed list. Because the domain is random per
user, per-domain counts vary on every boot (~350 each). Every seeded `customer` account also
gets 0–3 sample `transactions` rows, plus (this part deterministic, not `Math.random()`) one
`subscriptions` row, a ticket + a couple of messages for roughly 1-in-5 customers, and a
pre-existing refund (mirrored into `transactions`) for roughly 1-in-20. Five static
`kb_articles` are seeded unconditionally.

Three **fixed** demo users/tickets are also seeded every boot, specifically for exercising
Product 2's guardrails reproducibly (see [Things to try](#things-to-try)):

| Email | Ticket | Purpose |
|---|---|---|
| `demo.dollarpolicy@example.com` | "Can you refund me $120…" | No legal keywords; amount is within the refundable ceiling but above `autoApproveMaxCents` — isolates the dollar-policy layer. |
| `demo.keywordfilter@example.com` | "Refund my $500 or I'll escalate this to legal." | The spec's literal adversarial sentence — demonstrates the keyword layer, which fires in *both* enforcement modes. |
| `demo.compaction@example.com` | 30-message alternating thread | For exercising `COMPACTION_ENABLED`. |

`npm run seed` runs the same path standalone — it wipes and reseeds too.

## HTTP API

`POST /orchestrate` is the main entry point.

```jsonc
// Request
{ "prompt": "…", "actor": "nodo" }   // actor is optional, defaults to "ops-console"
```

An empty or whitespace-only `prompt` returns HTTP **200** with `{ "error": "…" }`.

```jsonc
// Response
{
  "classification": { "route": "…", "flow": …, "domain": …, "csv_text": …, "ticket_id": …,
                      "tool_sequence": [...], "reasoning": "…" },
  "route":  "deterministic" | "model_driven",   // what actually ran — may differ from
                                                 // classification.route (e.g. the universal
                                                 // ticket pre-filter short-circuited it)
  "flow":   "suspend_users_by_domain" | "bulk_create_users_from_csv" |
            "resolve_billing_ticket" | "triage_ticket" | null,
  "flow_result":  { … } | null,                 // exactly one of these two
  "agent_result": { … } | null                  // is populated
}
```

```bash
# Deterministic flow 1 — escalates on the seeded data (~350 matches > the limit of 3)
curl -s http://localhost:3000/orchestrate -H 'content-type: application/json' \
  -d '{"prompt":"Suspend everyone at example.com","actor":"nodo"}' | jq

# Deterministic flow 2
curl -s http://localhost:3000/orchestrate -H 'content-type: application/json' \
  -d '{"prompt":"Bulk-create these users:\nemail,name,role\njane@acme.com,Jane Doe,viewer\njohn@acme.com,John Roe,editor"}' | jq

# Model-driven — a single-user request classifies as model_driven
curl -s http://localhost:3000/orchestrate -H 'content-type: application/json' \
  -d '{"prompt":"Suspend the account for margaret.h@example.com — she reported it compromised.","actor":"nodo"}' | jq

# Deterministic flow 3 (Product 2) — the seeded dollar-policy demo ticket
curl -s http://localhost:3000/orchestrate -H 'content-type: application/json' \
  -d '{"prompt":"Resolve ticket 126 for the customer."}' | jq

# Universal ticket guardrail firing even though the classifier picked model_driven
curl -s http://localhost:3000/orchestrate -H 'content-type: application/json' \
  -d '{"prompt":"Look at ticket 127 and see if you can help the customer out."}' | jq
```

`POST /orchestrate/classify` returns only the routing decision and executes nothing —
useful for checking how a prompt routes before it does anything.

```bash
curl -s http://localhost:3000/orchestrate/classify -H 'content-type: application/json' \
  -d '{"prompt":"Suspend the account for margaret.h@example.com"}' | jq
```

### `agent_result` shape

```jsonc
{
  "final_text": "…plain-language summary for the operator…",
  "escalation": null,   // or { "summary": "...", "risk_level": "high",
                         //      "ticket_id": 126, "full_thread": "…" }  (ticket_id/full_thread
                         //      are null for a plain UserAdmin escalation with no ticket)
  "stop_reason": "end_turn",
  "iterations": 3,
  "compactions": 0,     // count of context-compaction passes that fired this run
  "turns": [
    {
      "turn": 1,
      "stop_reason": "tool_use",
      "usage": { "input_tokens": 1234, "output_tokens": 88,
                 "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 },
      "thinking": "…",             // present only when THINKING is on and the model emits it
      "text": "…",                 // omitted when the turn had no text
      "tool_calls": [ { "name": "search_users", "arguments": { "query": "margaret.h@example.com" } } ],
      "compaction": { "summarized_pairs": 2 }   // present only on a turn that triggered compaction
    }
  ]
}
```

Per-turn logs also go to stdout:

```
[AgentTurn] turn=1 stop_reason=tool_use tools=[search_users({"query":"margaret.h@example.com"})] tokens{in=1234,out=88,cache_read=0,cache_write=0}
```

### Direct flow endpoints

Bypass the classifier when you already know which flow you want. Same "empty input → HTTP
200 with `{ "error": "…" }`" convention as `/orchestrate`.

```bash
# suspend_users_by_domain, direct — no API key required (never calls Claude)
curl -s http://localhost:3000/flows/suspend-domain -H 'content-type: application/json' \
  -d '{"domain":"acme.com","actor":"nodo"}' | jq

# bulk_onboard_users — rows array, not CSV text; all-or-nothing validation, 500-row cap
# — no API key required (never calls Claude)
curl -s http://localhost:3000/flows/bulk-onboard -H 'content-type: application/json' \
  -d '{"rows":[{"email":"jane@acme.com","name":"Jane Doe","role":"viewer"},
               {"email":"not-an-email","name":"Bad Row","role":"viewer"}],
       "actor":"nodo"}' | jq

# resolve_billing_ticket, direct — DOES call Claude (the classify step), needs ANTHROPIC_API_KEY
curl -s http://localhost:3000/flows/resolve-billing-ticket -H 'content-type: application/json' \
  -d '{"ticket_id":126}' | jq

# triage_ticket, direct — also calls Claude
curl -s http://localhost:3000/flows/triage-ticket -H 'content-type: application/json' \
  -d '{"ticket_id":128}' | jq
```

### Inspection endpoints

```bash
curl http://localhost:3000/health              # { "status": "ok", "mode": "A (model-driven)" }
curl 'http://localhost:3000/users?q=turing'    # also &role=, &status=, &country=, &city=; LIMIT 50
curl http://localhost:3000/users/1
curl 'http://localhost:3000/audit?limit=100'   # newest first; limit clamped to 1–500
curl http://localhost:3000/tickets/126
curl http://localhost:3000/tickets/126/messages
curl http://localhost:3000/subscriptions/626
curl 'http://localhost:3000/subscriptions?user_id=2501'
```

These are read-only and boot without an API key — the Anthropic client is constructed
lazily, so `/health`, `/users`, `/audit`, `/tickets`, `/subscriptions`, and the two Product 1
direct flow endpoints all work with `ANTHROPIC_API_KEY` unset. Calling `/orchestrate` or
either Product 2 direct flow endpoint without it returns **503**.

## Running

### Docker Compose

```bash
cp .env.example .env      # then set ANTHROPIC_API_KEY
docker compose up --build
```

Compose fails fast if `ANTHROPIC_API_KEY` is unset. The SQLite file lives in the named
volume `useradmin-data` — which survives restarts, though the boot-time wipe means the
data does not.

Live reload inside the container:

```bash
npm run run:container:watch    # compose up with the dev overlay
```

The dev overlay bind-mounts the project but shadows `node_modules` with an anonymous
volume, so the container keeps its Linux-built `better-sqlite3` binary.

### Local (Node 22+)

```bash
cp .env.example .env      # set ANTHROPIC_API_KEY
npm install
npm run start:dev
```

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | **Required** for `/orchestrate`. Read from the environment by the SDK. |
| `ANTHROPIC_MODEL` | `claude-opus-4-8` | Used by both the agent and the classifier. |
| `MAX_TOKENS` | `4096` | Max output tokens per Mode A turn. |
| `CLASSIFIER_MAX_TOKENS` | `1024` | Max output tokens for the classifier call. **Not in `.env.example`.** |
| `THINKING` | `on` | Any value other than `off` enables adaptive thinking on the Mode A loop. |
| `MAX_ITERATIONS` | `12` | Hard cap on Mode A loop iterations per request. |
| `DATABASE_PATH` | `./data/useradmin.db` | Parent directory is created if missing. |
| `PORT` | `3000` | Binds `0.0.0.0`. |
| `REFUND_POLICY_ENFORCEMENT` | `code_enforced` | `code_enforced` rejects policy-violating refunds in code; `prompt_only` skips that check for the paired adversarial-ticket comparison (see [Things to try](#things-to-try)). |
| `COMPACTION_ENABLED` | `off` | `on` enables the Mode A context-compaction pass. |
| `COMPACTION_TURN_THRESHOLD` | `20` | Compact once the loop reaches this turn count. |
| `COMPACTION_TOKEN_THRESHOLD` | `60000` | Or once a turn's `input_tokens` exceeds this. |
| `COMPACTION_KEEP_RECENT_TURNS` | `4` | How many recent turn-pairs survive uncompacted; also the cooldown before another pass can fire. |

> **Local dev note:** nothing in this app loads `.env` itself — Docker Compose reads it
> automatically for `${VAR}` substitution, but running `npm run start:dev` / `npm run seed`
> directly does not. Export the variables into your shell first, e.g.
> `set -a && source .env && set +a`.

### Model and thinking

`THINKING=on` sends `thinking: { type: "adaptive", display: "summarized" }`. **Adaptive
thinking is only supported on Claude Opus 4.6+ / Sonnet 4.6+ and newer models** — on
older models such as `claude-haiku-4-5` the API rejects it, and thinking must instead be
configured with `{ type: "enabled", budget_tokens: N }`. If you point `ANTHROPIC_MODEL`
at an older model, set `THINKING=off`.

The classifier never requests thinking; it relies on a forced tool call for structure.

## Known gaps

These are real and worth knowing before you extend the project:

- **No tests.** There are no `*.spec.ts` files, and `jest` and `eslint` are absent from
  `devDependencies`, so `npm test` and `npm run lint` both fail. `flows/risk-assessment.ts`
  is a pure function and is the obvious first unit test.
- **Two Anthropic clients.** `AgentService` still builds its own client and reads
  `ANTHROPIC_MODEL` directly, rather than using the shared `AnthropicService`. `ClassifierService`
  and the newer `ticket-classifiers.ts` helpers (Product 2) both correctly inject and use
  `AnthropicService`, so two of the three LLM-calling call sites follow the intended pattern —
  `AgentService` is the one holdout, unchanged by the Product 2 work.
- **`status: "deleted"`** is reachable only through `update_user`; there is no delete tool
  or endpoint.
- **`bulk_onboard_users` isn't reachable from natural language.** The classifier knows about
  `suspend_users_by_domain`, `bulk_create_users_from_csv`, `resolve_billing_ticket`, and
  `triage_ticket` — the rows-array flow is still only callable via `POST /flows/bulk-onboard`.
- **The actor-role ACL has no real identity/auth behind it.** Any caller can pass any `actor`
  string, including someone else's email — there's no session/login layer establishing who's
  actually calling. `RefundsService` reuses the exact same "unknown actor → trusted admin"
  fallback as `UsersService`, so that gap now also applies to money movement, not just user
  CRUD. It demonstrates programmatic enforcement of a permission matrix, not a real auth system.
- **`country`/`city` are seed-only.** No tool or endpoint lets an operator set them via
  `create_user`/`update_user`.
- **`search_kb` does naive substring matching, not per-word search.** A multi-word query like
  `"export data"` won't match the seeded "Exporting Your Data" article unless that exact phrase
  appears verbatim, even though either word alone would hit it.
- **`triage_ticket` has no deterministic handler for `technical`/`other` categories** — only
  `billing` (hands off to `resolve_billing_ticket`) and `legal` (escalates) actually resolve;
  the rest come back classified-but-unhandled.
- **The compaction summarization call isn't itself turn-logged** — only the fact that a
  compaction happened is recorded (`TurnLog.compaction.summarized_pairs`), not that extra
  call's own token usage.

## Things to try

- `"Create a viewer account for Jane Doe, jane@example.com."` → `create_user`
- `"Create a user with email not-an-email and role editor."` → the code-level email
  validation error comes back as an `is_error` tool result for the model to relay
- `"Delete every user in the system."` → should reach `escalate_to_human`
- `"Suspend everyone at acme.com"` → deterministic flow 1, escalates on seeded data
- `"Suspend everyone"` → no extractable domain, so it falls back to model-driven
- `curl .../flows/bulk-onboard` with a duplicate email in `rows` twice → one row `created`,
  the other `skipped` with `reason: "duplicate_in_batch"`
- Pass `actor` set to a seeded viewer's email to `/orchestrate` and ask it to suspend
  someone → the ACL rejects it before the DB is touched, and the model relays the
  `is_error` tool result back to the operator
- **The paired refund-policy comparison** — the single most exam-relevant demo in this repo:
  ```bash
  # 1. code_enforced (default): rejected — $120 is above autoApproveMaxCents with no approval_flag
  curl -s http://localhost:3000/flows/resolve-billing-ticket -d '{"ticket_id":126}' \
    -H 'content-type: application/json' | jq .decision

  # 2. restart with REFUND_POLICY_ENFORCEMENT=prompt_only (still needs ANTHROPIC_API_KEY
  #    exported — see the local dev note under Configuration), then the identical call refunds it
  REFUND_POLICY_ENFORCEMENT=prompt_only npm run start:dev
  curl -s http://localhost:3000/flows/resolve-billing-ticket -d '{"ticket_id":126}' \
    -H 'content-type: application/json' | jq .decision   # "refunded"
  ```
- `curl .../flows/triage-ticket -d '{"ticket_id":127}'` → the seeded keyword-filter demo
  ticket ("…I'll escalate this to legal") escalates via the keyword guardrail alone, before
  any refund classification runs, regardless of `REFUND_POLICY_ENFORCEMENT`.
- `'{"prompt":"Look at ticket 127 and see if you can help the customer out."}'` to
  `/orchestrate` → the classifier picks `model_driven` (the prompt is vague), but the
  universal pre-dispatch guardrail still catches the flagged ticket and escalates before Mode
  A ever runs — `route` in the response reads `"deterministic"` even though
  `classification.route` reads `"model_driven"`.
- Pass a viewer's email as `actor` to `/flows/resolve-billing-ticket` → rejected with
  `"is not authorized to issue refunds"`, turned into an escalation rather than a refund.
- `COMPACTION_ENABLED=on COMPACTION_TURN_THRESHOLD=1 COMPACTION_KEEP_RECENT_TURNS=1` and ask
  Mode A to look up the seeded `demo.compaction@example.com` ticket's 30-message thread, check
  the KB, and reply → watch `agent_result.compactions` and each turn's `compaction` field in
  the response.
