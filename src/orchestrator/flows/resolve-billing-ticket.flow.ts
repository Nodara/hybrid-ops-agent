import { Injectable, Logger } from "@nestjs/common";
import { AnthropicService } from "../../llm/anthropic.service";
import { UsersService } from "../../users/users.service";
import { TicketsService } from "../../support-desk/tickets.service";
import { SubscriptionsService } from "../../support-desk/subscriptions.service";
import { RefundsService, RefundOperationError } from "../../support-desk/refunds.service";
import { Ticket, TicketMessage } from "../../support-desk/support-desk.types";
import { classifyRefundIntent } from "./ticket-classifiers";
import { FlowStep, ResolveBillingTicketResult } from "./flow.types";

/**
 * Deterministic Flow — resolve a billing ticket: classify -> fetch customer +
 * subscription -> check policy (both layers, in RefundsService) -> refund or
 * escalate -> reply. This is the first flow in the codebase that needs an LLM
 * call (the classify step), so unlike Product 1's flows, execute() is async.
 */
@Injectable()
export class ResolveBillingTicketFlow {
  private readonly logger = new Logger(ResolveBillingTicketFlow.name);

  constructor(
    private readonly tickets: TicketsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly refunds: RefundsService,
    private readonly users: UsersService,
    private readonly anthropic: AnthropicService,
  ) {}

  async execute(ticketId: number, actor: string): Promise<ResolveBillingTicketResult> {
    const steps: FlowStep[] = [];
    const ticket = this.tickets.getById(ticketId);

    // Step 0 — legal/security pre-filter, in code, BEFORE any model call
    // touches this ticket for a refund decision. Independent of the dollar
    // policy check below (two separate guardrails).
    const flags = this.tickets.checkLegalOrSecurityFlags(ticketId);
    steps.push({ step: "legal_security_prefilter", detail: { ...flags } });
    if (flags.flagged) {
      return this.escalate(
        ticket,
        steps,
        `Legal/security keywords matched: ${flags.matched_keywords.join(", ")}`,
      );
    }

    // Step 1 — classify: does this ticket want a refund, and how much?
    const thread = this.tickets.getThread(ticketId);
    const classification = await classifyRefundIntent(this.anthropic, ticket, thread);
    steps.push({ step: "classify", detail: classification as unknown as Record<string, unknown> });

    if (!classification.wantsRefund) {
      const reply = this.tickets.addMessage(
        ticketId,
        "agent",
        "Thanks for reaching out — routing you to a support agent for a full response.",
      );
      steps.push({ step: "reply", detail: { decision: "replied_no_refund" } });
      return {
        flow: "resolve_billing_ticket",
        ticket_id: ticketId,
        decision: "replied_no_refund",
        requested_amount_cents: null,
        refund: null,
        escalation: null,
        reply,
        steps,
      };
    }

    // Step 2 — fetch customer + subscription "in parallel" (both are
    // synchronous better-sqlite3 reads under the hood; this models the
    // step-graph shape from the spec).
    const [customer, subscription] = await Promise.all([
      Promise.resolve(this.users.getById(ticket.user_id)),
      Promise.resolve(this.subscriptions.getByUserId(ticket.user_id)),
    ]);
    steps.push({
      step: "fetch_customer_and_subscription",
      detail: { user_id: customer.id, subscription_id: subscription.id },
    });

    // Steps 3 & 4 — check policy (both layers, inside RefundsService — the
    // single source of truth shared with Mode A's issue_refund tool) and
    // refund, or catch the rejection and escalate.
    const amountCents = classification.requestedAmountCents ?? 0;
    try {
      const refund = this.refunds.issueRefund(
        actor,
        subscription.id,
        amountCents,
        `Ticket #${ticketId}: ${classification.reasoning}`,
        false,
      );
      const reply = this.tickets.addMessage(
        ticketId,
        "agent",
        `We've issued a refund of $${(amountCents / 100).toFixed(2)}.`,
      );
      this.tickets.updateStatus(ticketId, "resolved");
      steps.push({
        step: "check_policy_and_refund",
        detail: { decision: "refunded", refund_id: refund.id },
      });
      return {
        flow: "resolve_billing_ticket",
        ticket_id: ticketId,
        decision: "refunded",
        requested_amount_cents: amountCents,
        refund,
        escalation: null,
        reply,
        steps,
      };
    } catch (err) {
      const message =
        err instanceof RefundOperationError
          ? err.message
          : `Unexpected error: ${(err as Error).message}`;
      this.logger.warn(`resolve_billing_ticket #${ticketId} rejected: ${message}`);
      steps.push({ step: "check_policy_and_refund", detail: { decision: "escalated", reason: message } });
      return this.escalate(ticket, steps, message, thread, amountCents);
    }
  }

  private escalate(
    ticket: Ticket,
    steps: FlowStep[],
    reason: string,
    thread?: TicketMessage[],
    requestedAmountCents: number | null = null,
  ): ResolveBillingTicketResult {
    this.tickets.updateStatus(ticket.id, "escalated");
    const full_thread = [
      `Subject: ${ticket.subject}`,
      ticket.body,
      ...(thread ?? this.tickets.getThread(ticket.id)).map((m) => `[${m.sender}] ${m.body}`),
    ].join("\n");
    steps.push({ step: "escalate", detail: { reason } });
    return {
      flow: "resolve_billing_ticket",
      ticket_id: ticket.id,
      decision: "escalated",
      requested_amount_cents: requestedAmountCents,
      refund: null,
      escalation: { summary: reason, risk_level: "medium", reasons: [reason], full_thread },
      reply: null,
      steps,
    };
  }
}
