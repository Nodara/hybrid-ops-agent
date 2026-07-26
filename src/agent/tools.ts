import Anthropic from "@anthropic-ai/sdk";
import { UsersService, UserOperationError } from "../users/users.service";
import {
  Role,
  Status,
  UpdatableUserFields,
  isRole,
  isStatus,
} from "../users/user.types";

/** The tool that ends the loop and hands control back to a human operator. */
export const ESCALATE_TOOL_NAME = "escalate_to_human";

/**
 * Tool schemas exposed to Claude. In Mode A the model sees ALL of these with
 * tool_choice: auto and decides which (if any) to call.
 *
 * Note the deliberate schema choices from the brief:
 *  - suspend_user.reason is REQUIRED in the input_schema (not just described).
 *  - create_user does not describe email rules in prose; format is enforced in code.
 */
export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "search_users",
    description:
      "Search users by a free-text query matched against email and name. " +
      "Optionally filter by role, status, country, and/or city. Returns a list of " +
      "user summaries. Use an empty query string to list users (optionally narrowed " +
      "by the filters) — e.g. to look up a customer by email, pass the email as the " +
      "query with role: \"customer\".",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Free text matched against email or name. Empty string matches all.",
        },
        role: {
          type: "string",
          enum: ["admin", "editor", "viewer", "customer"],
          description: "Optional role filter.",
        },
        status: {
          type: "string",
          enum: ["active", "suspended", "deleted"],
          description: "Optional status filter.",
        },
        country: {
          type: "string",
          description: "Optional exact-match country filter.",
        },
        city: {
          type: "string",
          description: "Optional exact-match city filter.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_user",
    description: "Fetch the full record for a single user by their numeric id.",
    input_schema: {
      type: "object",
      properties: {
        user_id: { type: "integer", description: "Numeric id of the user." },
      },
      required: ["user_id"],
    },
  },
  {
    name: "create_user",
    description:
      "Create a new user with the given email, name, and role. " +
      "Returns the created record. The email must be unique.",
    input_schema: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "Email address for the new user.",
        },
        name: { type: "string", description: "Full name of the new user." },
        role: {
          type: "string",
          enum: ["admin", "editor", "viewer"],
          description: "Role to assign.",
        },
      },
      required: ["email", "name", "role"],
    },
  },
  {
    name: "update_user",
    description:
      "Apply a partial update to an existing user. Only the fields you include in " +
      "`fields` are changed; omitted fields are left as-is.",
    input_schema: {
      type: "object",
      properties: {
        user_id: {
          type: "integer",
          description: "Numeric id of the user to update.",
        },
        fields: {
          type: "object",
          description: "Subset of fields to change.",
          properties: {
            email: { type: "string" },
            name: { type: "string" },
            role: { type: "string", enum: ["admin", "editor", "viewer"] },
            status: {
              type: "string",
              enum: ["active", "suspended", "deleted"],
            },
          },
          additionalProperties: false,
        },
      },
      required: ["user_id", "fields"],
    },
  },
  {
    name: "suspend_user",
    description:
      'Suspend a user, setting their status to "suspended". A reason must be supplied ' +
      "and is written to the audit log.",
    input_schema: {
      type: "object",
      properties: {
        user_id: {
          type: "integer",
          description: "Numeric id of the user to suspend.",
        },
        reason: {
          type: "string",
          description: "Why the user is being suspended.",
        },
      },
      // `reason` is required at the schema level, not merely described in prose.
      required: ["user_id", "reason"],
    },
  },
  {
    name: ESCALATE_TOOL_NAME,
    description:
      "Escalate to a human operator for anything dangerous, ambiguous, or outside " +
      "your authority (e.g. bulk deletions, privilege escalation to admin, or requests " +
      "you cannot safely fulfill). Calling this ENDS the session — no further tools run. " +
      "If this escalation concerns a SupportDesk ticket, set ticket_id and full_thread so " +
      "the human picking it up has the complete history, not just a one-line note.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "Concise summary of the situation and what needs human judgment.",
        },
        risk_level: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
          description: "Assessed risk of the requested operation.",
        },
        ticket_id: {
          type: ["integer", "null"],
          description: "SupportDesk ticket id if this escalation concerns a ticket, else omit.",
        },
        full_thread: {
          type: ["string", "null"],
          description:
            "Full ticket message history plus your reasoning summary, packaged as text. " +
            "Required whenever ticket_id is set.",
        },
      },
      required: ["summary", "risk_level"],
    },
  },
];

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

/** Names handled by executeTool — lets the merged Mode A dispatcher route by name. */
export const USER_ADMIN_TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((t) => t.name));

export function ok(payload: unknown): ToolExecutionResult {
  return { content: JSON.stringify(payload), isError: false };
}

export function fail(message: string): ToolExecutionResult {
  return { content: JSON.stringify({ error: message }), isError: true };
}

export function coerceId(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UserOperationError(`Invalid id: ${JSON.stringify(raw)}.`);
  }
  return n;
}

/**
 * Executes a single (non-escalation) tool call. `escalate_to_human` is handled
 * by the agent loop itself, since it terminates the session rather than
 * producing a tool_result.
 */
export function executeTool(
  users: UsersService,
  actor: string,
  name: string,
  input: Record<string, unknown>,
): ToolExecutionResult {
  try {
    switch (name) {
      case "search_users": {
        const role = input.role;
        const status = input.status;
        return ok(
          users.search(
            typeof input.query === "string" ? input.query : "",
            isRole(role) ? (role as Role) : undefined,
            isStatus(status) ? (status as Status) : undefined,
            typeof input.country === "string" ? input.country : undefined,
            typeof input.city === "string" ? input.city : undefined,
          ),
        );
      }

      case "get_user":
        return ok(users.getById(coerceId(input.user_id)));

      case "create_user":
        return ok(
          users.create(
            actor,
            String(input.email ?? ""),
            String(input.name ?? ""),
            input.role as Role,
          ),
        );

      case "update_user": {
        const fields = (input.fields ?? {}) as UpdatableUserFields;
        return ok(users.update(actor, coerceId(input.user_id), fields));
      }

      case "suspend_user":
        return ok(
          users.suspend(
            actor,
            coerceId(input.user_id),
            String(input.reason ?? ""),
          ),
        );

      default:
        return fail(`Unknown tool: ${name}.`);
    }
  } catch (err) {
    if (err instanceof UserOperationError) return fail(err.message);
    // Unexpected error — surface a generic message to the model, but rethrow-style
    // detail stays server-side via the thrown object's message.
    return fail(`Tool "${name}" failed: ${(err as Error).message}`);
  }
}
