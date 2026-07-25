# UserAdmin Agent — Product 1

An internal admin copilot. Ops staff type natural-language requests; a **model-driven
(Mode A)** agent manages users in a database via a small set of tools.

- **Framework:** NestJS
- **Store:** SQLite for local dev (the data model maps 1:1 to Postgres — see `docker-compose.yml`)
- **Model:** `claude-opus-4-8`, adaptive thinking, `tool_choice: auto`
- **Runtime:** Docker Compose

## Mode A — model-driven

Claude is handed **all six tools** with `tool_choice: auto` and decides what to do.
We run the tool loop by hand (in `src/agent/agent.service.ts`) so we can:

- **log every turn** — the tool(s) called and their arguments, the `stop_reason`,
  and token counts (`src/agent/turn-logger.service.ts`); and
- **terminate cleanly** when the model calls `escalate_to_human`.

The full assistant turn (including thinking blocks) is preserved and replayed each
iteration, so the model keeps its reasoning across tool calls.

## Hybrid orchestration — classifier + deterministic flows

`POST /orchestrate` runs a **classifier agent** first (one forced-tool Claude call,
`src/orchestrator/classifier.service.ts`) that inspects the prompt and returns a
structured routing decision: **deterministic** (which flow + extracted params +
planned step sequence) or **model_driven** (fall back to Mode A above). If a
deterministic flow is chosen but its required parameter is missing, the
orchestrator falls back to model-driven rather than guessing.

Two deterministic flows (fixed, code-defined step sequences — not model-decided):

| Flow | Steps | Behaviour |
|------|-------|-----------|
| `suspend_users_by_domain` | `find_users_by_domain → assess_risk → escalate_or_suspend` | Fetches all users at a domain, computes a deterministic risk score, then **escalates to a human** if matches > 3, any user is an admin, or risk is high — otherwise suspends every active match. |
| `bulk_create_users_from_csv` | `parse_csv → create_users` | Parses CSV text (optional header, any column order) and creates each user; bad rows are collected in `failed` (partial success). |

```bash
# Deterministic flow 1 — escalates on the seeded @example.com data (thousands match)
curl -s http://localhost:3000/orchestrate -H 'content-type: application/json' \
  -d '{"prompt":"Suspend everyone at example.com","actor":"nodo"}' | jq

# Deterministic flow 2
curl -s http://localhost:3000/orchestrate -H 'content-type: application/json' \
  -d '{"prompt":"Bulk-create these users:\nemail,name,role\njane@acme.com,Jane Doe,viewer\njohn@acme.com,John Roe,editor"}' | jq

# See only the routing decision, without executing
curl -s http://localhost:3000/orchestrate/classify -H 'content-type: application/json' \
  -d '{"prompt":"Suspend the account for margaret.h@example.com"}' | jq
```

Response shape: `{ classification, route, flow, flow_result, agent_result }` — exactly
one of `flow_result` / `agent_result` is populated depending on the route taken.

## Data model

```
users(id, email, name, role[admin|editor|viewer], status[active|suspended|deleted], created_at)
audit_log(id, actor, action, target_user_id, timestamp, details)
```

Every mutating tool writes an `audit_log` row. Schema + seed data live in
`src/database/database.service.ts` (created and seeded automatically on first boot).

## Tools (6)

| Tool | Notes |
|------|-------|
| `search_users(query, role?, status?)` | Returns user summaries. |
| `get_user(user_id)` | Full record. |
| `create_user(email, name, role)` | **Email format is validated in code**, not the prompt (`user.types.ts` → `isValidEmail`). |
| `update_user(user_id, fields)` | Partial update. |
| `suspend_user(user_id, reason)` | `reason` is **required in the `input_schema`**, not just described in prose. |
| `escalate_to_human(summary, risk_level)` | **Terminates the loop** for dangerous/ambiguous ops. |

Invalid input (bad email, missing user, etc.) comes back to the model as an
`is_error` tool result so it can correct itself, rather than crashing the loop.

## Running

### Docker Compose (recommended)

```bash
cp .env.example .env      # then put your key in ANTHROPIC_API_KEY
docker compose up --build
```

### Local (Node 22+)

```bash
cp .env.example .env      # set ANTHROPIC_API_KEY
npm install
npm run start:dev
```

## HTTP API

`POST /orchestrate` is the single entry point (see **Hybrid orchestration** above).
For a single-user request it classifies as `model_driven` and runs the Mode A agent:

```bash
curl -s http://localhost:3000/orchestrate \
  -H 'content-type: application/json' \
  -d '{"prompt":"Suspend the account for margaret.h@example.com — she reported it compromised.","actor":"nodo"}' | jq
```

The Mode A run appears nested under `agent_result` (shape below); for a deterministic
route it is `null` and `flow_result` is populated instead.

```jsonc
{
  "final_text": "…plain-language summary for the operator…",
  "escalation": null,                 // or { "summary": "...", "risk_level": "high" }
  "stop_reason": "end_turn",
  "iterations": 3,
  "turns": [                          // one entry per model turn
    {
      "turn": 1,
      "stop_reason": "tool_use",
      "usage": { "input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 },
      "text": "…",
      "tool_calls": [ { "name": "search_users", "arguments": { "query": "margaret.h@example.com" } } ]
    }
  ]
}
```

Per-turn logs are also printed to stdout by `AgentTurn`:

```
[AgentTurn] turn=1 stop_reason=tool_use tools=[search_users({"query":"margaret.h@example.com"})] tokens{in=1234,out=88,cache_read=0,cache_write=0}
```

### Inspection endpoints

```bash
curl http://localhost:3000/health
curl 'http://localhost:3000/users?q=turing'
curl http://localhost:3000/users/1
curl http://localhost:3000/audit          # recent audit-log rows, newest first
```

## Things to try

- `"Create a viewer account for Jane Doe, jane@example.com."`
- `"Create a user with email not-an-email and role editor."` → the model relays the
  code-level email validation error.
- `"Delete every user in the system."` → the model should `escalate_to_human`.

## Configuration

See `.env.example`. Notable knobs: `ANTHROPIC_MODEL`, `MAX_TOKENS`, `THINKING`
(`on`/`off`), `MAX_ITERATIONS` (hard cap on loop iterations per request),
`DATABASE_PATH`.
