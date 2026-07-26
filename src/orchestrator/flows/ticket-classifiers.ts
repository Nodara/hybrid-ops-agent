import Anthropic from "@anthropic-ai/sdk";
import { AnthropicService } from "../../llm/anthropic.service";
import { Ticket, TicketMessage } from "../../support-desk/support-desk.types";

export interface RefundIntentClassification {
  wantsRefund: boolean;
  requestedAmountCents: number | null;
  reasoning: string;
}

const REFUND_INTENT_TOOL_NAME = "classify_refund_intent";

const REFUND_INTENT_TOOL: Anthropic.Tool = {
  name: REFUND_INTENT_TOOL_NAME,
  description: "Record whether this ticket is asking for a refund, and for how much.",
  input_schema: {
    type: "object",
    properties: {
      wants_refund: {
        type: "boolean",
        description: "True if the customer is asking for a refund.",
      },
      requested_amount_cents: {
        type: ["integer", "null"],
        description:
          "The refund amount requested, in cents. Null if no specific amount was stated.",
      },
      reasoning: { type: "string", description: "One or two sentences of justification." },
    },
    required: ["wants_refund", "requested_amount_cents", "reasoning"],
  },
};

/** Forced-tool classification: does this ticket want a refund, and how much? */
export async function classifyRefundIntent(
  anthropic: AnthropicService,
  ticket: Ticket,
  thread: TicketMessage[],
): Promise<RefundIntentClassification> {
  const transcript = [
    `Subject: ${ticket.subject}`,
    ticket.body,
    ...thread.map((m) => `[${m.sender}] ${m.body}`),
  ].join("\n");

  const response = await anthropic.getClient().messages.create({
    model: anthropic.model,
    max_tokens: 512,
    system:
      "Classify whether this support ticket is requesting a refund, and for how much, based " +
      "solely on the text provided.",
    tools: [REFUND_INTENT_TOOL],
    tool_choice: { type: "tool", name: REFUND_INTENT_TOOL_NAME },
    messages: [{ role: "user", content: transcript }],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === REFUND_INTENT_TOOL_NAME,
  );
  const input = (toolUse?.input ?? {}) as Record<string, unknown>;
  return {
    wantsRefund: input.wants_refund === true,
    requestedAmountCents:
      typeof input.requested_amount_cents === "number" &&
      Number.isInteger(input.requested_amount_cents)
        ? input.requested_amount_cents
        : null,
    reasoning: typeof input.reasoning === "string" ? input.reasoning : "",
  };
}

export type TicketCategory = "billing" | "technical" | "legal" | "other";

export interface TicketCategoryClassification {
  category: TicketCategory;
  reasoning: string;
}

const TICKET_CATEGORY_TOOL_NAME = "classify_ticket_category";

const TICKET_CATEGORY_TOOL: Anthropic.Tool = {
  name: TICKET_CATEGORY_TOOL_NAME,
  description: "Record which category this support ticket falls into.",
  input_schema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: ["billing", "technical", "legal", "other"],
        description: "The single best-fit category for this ticket.",
      },
      reasoning: { type: "string", description: "One sentence explaining the categorization." },
    },
    required: ["category", "reasoning"],
  },
};

/** Cheap first-pass classifier, run before deciding whether to hand off to a more expensive flow. */
export async function classifyTicketCategory(
  anthropic: AnthropicService,
  ticket: Ticket,
): Promise<TicketCategoryClassification> {
  const response = await anthropic.getClient().messages.create({
    model: anthropic.model,
    max_tokens: 256,
    system:
      "Classify this support ticket's subject and body into exactly one category: billing " +
      "(payments, refunds, invoices, subscriptions), technical (bugs, access, errors), legal " +
      "(legal threats, disputes, regulatory/security concerns), or other.",
    tools: [TICKET_CATEGORY_TOOL],
    tool_choice: { type: "tool", name: TICKET_CATEGORY_TOOL_NAME },
    messages: [{ role: "user", content: `Subject: ${ticket.subject}\n${ticket.body}` }],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === "tool_use" && b.name === TICKET_CATEGORY_TOOL_NAME,
  );
  const input = (toolUse?.input ?? {}) as Record<string, unknown>;
  const category: TicketCategory =
    input.category === "billing" ||
    input.category === "technical" ||
    input.category === "legal" ||
    input.category === "other"
      ? input.category
      : "other";
  return {
    category,
    reasoning: typeof input.reasoning === "string" ? input.reasoning : "",
  };
}
