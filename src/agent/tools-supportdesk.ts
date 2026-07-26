import Anthropic from "@anthropic-ai/sdk";
import { UsersService } from "../users/users.service";
import {
  TicketsService,
  TicketOperationError,
} from "../support-desk/tickets.service";
import {
  SubscriptionsService,
  SubscriptionOperationError,
} from "../support-desk/subscriptions.service";
import { RefundsService, RefundOperationError } from "../support-desk/refunds.service";
import { KbService } from "../support-desk/kb.service";
import { ok, fail, coerceId, ToolExecutionResult } from "./tools";

export interface SupportDeskToolDeps {
  users: UsersService;
  tickets: TicketsService;
  subscriptions: SubscriptionsService;
  refunds: RefundsService;
  kb: KbService;
}

/**
 * SupportDesk tools, merged into Mode A's single tool_choice:auto loop
 * alongside Product 1's TOOL_DEFINITIONS — one agent sees both domains.
 */
export const SUPPORT_DESK_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "search_kb",
    description:
      "Search the support knowledge base by free-text query matched against article " +
      "title, body, and keywords. Use an empty query to list the first articles.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free text to search for." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_customer",
    description:
      "Look up a customer by exact email address. Thin wrapper over searching users " +
      "with role=customer.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Exact email address of the customer." },
      },
      required: ["email"],
    },
  },
  {
    name: "get_subscription",
    description: "Fetch a customer's current subscription by their numeric user id.",
    input_schema: {
      type: "object",
      properties: {
        user_id: { type: "integer", description: "Numeric id of the customer." },
      },
      required: ["user_id"],
    },
  },
  {
    name: "get_ticket",
    description:
      "Fetch a support ticket and its full message thread by numeric ticket id. If the " +
      "ticket is flagged for legal/security content, the body and thread are withheld — " +
      "you must call escalate_to_human with ticket_id set instead of acting on it.",
    input_schema: {
      type: "object",
      properties: {
        ticket_id: { type: "integer", description: "Numeric id of the ticket." },
      },
      required: ["ticket_id"],
    },
  },
  {
    name: "issue_refund",
    description:
      "Issue a refund against a subscription. Rejected (as a tool error, not silently " +
      "adjusted) if the amount exceeds the refundable ceiling for that subscription's " +
      "remaining billing term, or — unless the deployment is running in prompt-only policy " +
      "mode — if it exceeds the autonomy policy threshold without approval_flag set.",
    input_schema: {
      type: "object",
      properties: {
        subscription_id: { type: "integer", description: "Numeric id of the subscription." },
        amount_cents: { type: "integer", description: "Refund amount in cents." },
        reason: { type: "string", description: "Why the refund is being issued." },
        approval_flag: {
          type: "boolean",
          description:
            "Set true only if a human/manager has already approved a refund above the " +
            "auto-approve threshold.",
        },
      },
      required: ["subscription_id", "amount_cents", "reason"],
    },
  },
  {
    name: "send_reply",
    description: "Send a reply message on a ticket, on behalf of the support agent.",
    input_schema: {
      type: "object",
      properties: {
        ticket_id: { type: "integer", description: "Numeric id of the ticket." },
        body: { type: "string", description: "Reply text to send to the customer." },
      },
      required: ["ticket_id", "body"],
    },
  },
];

export function executeSupportDeskTool(
  deps: SupportDeskToolDeps,
  actor: string,
  name: string,
  input: Record<string, unknown>,
): ToolExecutionResult {
  try {
    switch (name) {
      case "search_kb":
        return ok(deps.kb.search(typeof input.query === "string" ? input.query : ""));

      case "get_customer": {
        const email = String(input.email ?? "").trim().toLowerCase();
        const match =
          deps.users
            .search(email, "customer")
            .find((u) => u.email.toLowerCase() === email) ?? null;
        return ok({ customer: match });
      }

      case "get_subscription":
        return ok(deps.subscriptions.getByUserId(coerceId(input.user_id)));

      case "get_ticket": {
        const ticketId = coerceId(input.ticket_id);
        const flags = deps.tickets.checkLegalOrSecurityFlags(ticketId);
        if (flags.flagged) {
          // Body/thread are deliberately withheld — the model never sees
          // ticket content once flagged, so the guardrail can't be reasoned
          // around by an agent that already has the content in context.
          return ok({
            ticket_id: ticketId,
            legal_or_security_flag: true,
            matched_keywords: flags.matched_keywords,
            message:
              "This ticket cannot be handled autonomously. Call escalate_to_human with " +
              "ticket_id set.",
          });
        }
        return ok({
          ticket: deps.tickets.getById(ticketId),
          thread: deps.tickets.getThread(ticketId),
        });
      }

      case "issue_refund":
        return ok(
          deps.refunds.issueRefund(
            actor,
            coerceId(input.subscription_id),
            Number(input.amount_cents),
            String(input.reason ?? ""),
            Boolean(input.approval_flag),
          ),
        );

      case "send_reply": {
        const ticketId = coerceId(input.ticket_id);
        const body = String(input.body ?? "").trim();
        if (!body) throw new TicketOperationError("body is required.");
        return ok(deps.tickets.addMessage(ticketId, "agent", body));
      }

      default:
        return fail(`Unknown tool: ${name}.`);
    }
  } catch (err) {
    if (
      err instanceof TicketOperationError ||
      err instanceof SubscriptionOperationError ||
      err instanceof RefundOperationError
    ) {
      return fail(err.message);
    }
    return fail(`Tool "${name}" failed: ${(err as Error).message}`);
  }
}
