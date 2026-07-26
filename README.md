# User Management — Hybrid Agent Orchestrator

An internal user-administration copilot. Ops staff send natural-language requests to a
single endpoint; a **classifier agent** decides whether the request is handled by a
**deterministic, code-defined flow** or by a **model-driven agent loop**.

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
      │              → { route, flow, domain, csv_text, tool_sequence, reasoning }
      │
      ├── route = "deterministic" AND required param present
      │     ├── suspend_users_by_domain   → SuspendByDomainFlow
      │     └── bulk_create_users_from_csv → BulkCreateUsersFlow
      │
      └── route = "model_driven"  (or deterministic flow missing its param)
            └── AgentService — hand-rolled tool loop, 6 tools, tool_choice: auto
```

Two flows also have direct entry points that skip the classifier entirely —
`POST /flows/suspend-domain` and `POST /flows/bulk-onboard` — for callers that already know
which workflow they want (see [HTTP API](#http-api)).

Everything shares one `UsersService`, and every mutation writes an `audit_log` row
regardless of which path produced it, in the same DB transaction as the mutation.

### Why a classifier

Two operations are common, high-volume, and dangerous enough that we don't want a model
choosing the control flow: suspending an entire email domain, and bulk-creating users
from CSV. Those run as fixed step sequences in code. Everything else — single-user
lookups, updates, ambiguous or multi-step requests — goes to the model.

**Safety rule:** if the classifier picks a deterministic flow but the required parameter
is missing or blank, the orchestrator does **not** guess. It logs a warning and falls
back to the model-driven engine, which can ask the operator for clarification
(`orchestrator.service.ts:65`). The response always reports the route that *actually*
ran, which may differ from the classifier's `classification.route`.

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

## Mode A — model-driven

`AgentService` is given all six tools with `tool_choice: auto` and runs the tool loop by
hand so it can:

- **log every turn** — tools called with their arguments, `stop_reason`, and token counts
  (`agent/turn-logger.service.ts`);
- **terminate cleanly** when the model calls `escalate_to_human`; and
- **cap iterations** at `MAX_ITERATIONS`.

The full assistant turn — including thinking blocks — is pushed back onto `messages` each
iteration, so the model keeps its reasoning across tool calls. Parallel tool calls are
executed and returned as `tool_result` blocks in a single user turn.

> `escalate_to_human` is checked **before** any tools execute. If the model calls it
> alongside other tools in the same turn, those other tools do not run and no
> `tool_result` is returned — the loop breaks immediately.

### Tools (6)

| Tool | Notes |
|---|---|
| `search_users(query, role?, status?, country?, city?)` | Free-text against email and name; optional exact-match `role`/`status`/`country`/`city` filters. `role` includes `customer` (e.g. a customer lookup by email is `search_users({ query: email, role: "customer" })`). Empty query matches all. **`LIMIT 50`.** |
| `get_user(user_id)` | Full record. Errors if not found. |
| `create_user(email, name, role)` | Email format validated **in code** (`user.types.ts` → `isValidEmail`), not described in the prompt. Email is lowercased; uniqueness enforced. `role` ∈ admin/editor/viewer. |
| `update_user(user_id, fields)` | Partial update over `email`/`name`/`role`/`status`. Rejects an empty field set. |
| `suspend_user(user_id, reason)` | `reason` is **required in the `input_schema`**, not just in prose. Idempotent — re-suspending an already-suspended user no-ops the row but still audits the attempt. |
| `escalate_to_human(summary, risk_level)` | **Terminates the loop.** `risk_level` ∈ low/medium/high/critical. |

Invalid input (bad email, missing user, duplicate address, bad role) is returned to the
model as an `is_error` tool result so it can correct itself rather than crashing the loop.
So is an authorization failure — `create_user`, `update_user`, and `suspend_user` all check
the calling `actor`'s role first (see "Actor-role ACL" below) and return an `is_error` result
if it's not permitted, rather than mutating anything.

### Actor-role ACL

`UsersService` resolves every mutating call's `actor` string to a role before doing anything
else: a match against a known `users.email` uses that user's real role; anything else
(including the default `"ops-console"` label) is treated as a trusted internal caller and
resolves to `admin`. Permission matrix:

| Role | `create_user` | `update_user` | `suspend_user` |
|---|:---:|:---:|:---:|
| `viewer` | ✗ | ✗ | ✗ |
| `editor` | ✓ | ✓ | ✗ |
| `admin` | ✓ | ✓ | ✓ |

Enforced inside `UsersService` itself, not the tool prompt/schema — so it applies uniformly
whether the call came from the agent loop or a deterministic flow. There's no real
session/login layer behind this: any caller can pass any `actor` string, including someone
else's email.

## Data model

```
users(id, email, name, role[admin|editor|viewer|customer],
      status[active|suspended|deleted], country, city, created_at)
audit_log(id, actor, action, target_user_id, timestamp, details)
transactions(id, user_id, type[subscription_charge|refund|balance_credit|balance_debit],
             amount_cents, currency, created_at, metadata)
```

`audit_log.target_user_id` and `transactions.user_id` are foreign keys into `users`;
`journal_mode=WAL` and `foreign_keys=ON` are set at boot. `country`/`city` are nullable and
only ever populated by the seed generator — no tool or endpoint sets them today.
`transactions` is seeded but nothing in this codebase reads it yet; it exists to match the
shared-ledger shape `PRODUCT_SPECS.md` describes for a future Product 3.

### ⚠️ The database is wiped on every boot

`DatabaseService.onModuleInit()` runs `createSchema() → cleanUpAllTables() → seedIfEmpty()`
(`database/database.service.ts:21`). `cleanUpAllTables()` deletes every row from all three
tables and resets the autoincrement counters, so **the reseed always runs** and IDs are not
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
gets 0–3 sample `transactions` rows.

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
  "classification": { "route": "…", "flow": …, "domain": …, "csv_text": …,
                      "tool_sequence": [...], "reasoning": "…" },
  "route":  "deterministic" | "model_driven",   // what actually ran
  "flow":   "suspend_users_by_domain" | "bulk_create_users_from_csv" | null,
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
  "escalation": null,              // or { "summary": "...", "risk_level": "high" }
  "stop_reason": "end_turn",
  "iterations": 3,
  "turns": [
    {
      "turn": 1,
      "stop_reason": "tool_use",
      "usage": { "input_tokens": 1234, "output_tokens": 88,
                 "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 },
      "thinking": "…",             // present only when THINKING is on and the model emits it
      "text": "…",                 // omitted when the turn had no text
      "tool_calls": [ { "name": "search_users", "arguments": { "query": "margaret.h@example.com" } } ]
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
200 with `{ "error": "…" }`" convention as `/orchestrate`; no API key required (these never
call Claude).

```bash
# suspend_users_by_domain, direct
curl -s http://localhost:3000/flows/suspend-domain -H 'content-type: application/json' \
  -d '{"domain":"acme.com","actor":"nodo"}' | jq

# bulk_onboard_users — rows array, not CSV text; all-or-nothing validation, 500-row cap
curl -s http://localhost:3000/flows/bulk-onboard -H 'content-type: application/json' \
  -d '{"rows":[{"email":"jane@acme.com","name":"Jane Doe","role":"viewer"},
               {"email":"not-an-email","name":"Bad Row","role":"viewer"}],
       "actor":"nodo"}' | jq
```

### Inspection endpoints

```bash
curl http://localhost:3000/health              # { "status": "ok", "mode": "A (model-driven)" }
curl 'http://localhost:3000/users?q=turing'    # also &role=, &status=, &country=, &city=; LIMIT 50
curl http://localhost:3000/users/1
curl 'http://localhost:3000/audit?limit=100'   # newest first; limit clamped to 1–500
```

These are read-only and boot without an API key — the Anthropic client is constructed
lazily, so `/health`, `/users`, `/audit`, and the direct flow endpoints all work with
`ANTHROPIC_API_KEY` unset. Calling `/orchestrate` without it returns **503**.

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

### Model and thinking

`THINKING=on` sends `thinking: { type: "adaptive", display: "summarized" }`. **Adaptive
thinking is only supported on Claude Opus 4.6+ / Sonnet 4.6+ and newer models** — on
older models such as `claude-haiku-4-5` the API rejects it, and thinking must instead be
configured with `{ type: "enabled", budget_tokens: N }`. If you point `ANTHROPIC_MODEL`
at an older model, set `THINKING=off`.

The classifier never requests thinking; it relies on a forced tool call for structure.

## Known gaps

These are real and worth knowing before you extend the project:

- **The Mode A system prompt is one line.** The detailed operating guidelines are
  commented out at `agent/agent.service.ts:11-22`, leaving only *"You are UserAdmin, an
  internal copilot for operations staff who manage user accounts."* Tool-level schemas and
  descriptions still carry most of the behavior, but guidance on escalation thresholds,
  minimal changes, and summary style is currently inactive — so escalation and
  error-relaying behavior is less reliable than the tool descriptions alone suggest.
- **No tests.** There are no `*.spec.ts` files, and `jest` and `eslint` are absent from
  `devDependencies`, so `npm test` and `npm run lint` both fail. `flows/risk-assessment.ts`
  is a pure function and is the obvious first unit test.
- **Two Anthropic clients.** `AgentService` builds its own client and reads
  `ANTHROPIC_MODEL` directly, rather than using the shared `AnthropicService` that the
  classifier depends on. They resolve to the same values, but the duplication means a
  change has to be made in two places.
- **No prompt caching.** The tool definitions and system prompt are re-sent uncached on
  every turn of the loop.
- **`status: "deleted"`** is reachable only through `update_user`; there is no delete tool
  or endpoint.
- **`bulk_onboard_users` isn't reachable from natural language.** The classifier only knows
  about `suspend_users_by_domain` and `bulk_create_users_from_csv`; the rows-array flow is
  only callable via `POST /flows/bulk-onboard`.
- **The actor-role ACL has no real identity/auth behind it.** Any caller can pass any `actor`
  string, including someone else's email — there's no session/login layer establishing who's
  actually calling. It demonstrates programmatic enforcement of a permission matrix, not a
  real auth system.
- **`country`/`city` are seed-only.** No tool or endpoint lets an operator set them via
  `create_user`/`update_user`.

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
