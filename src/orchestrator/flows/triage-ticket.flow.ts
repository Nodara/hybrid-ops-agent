import { Injectable } from "@nestjs/common";
import { AnthropicService } from "../../llm/anthropic.service";
import { TicketsService } from "../../support-desk/tickets.service";
import { classifyTicketCategory } from "./ticket-classifiers";
import { FlowStep, TriageTicketResult } from "./flow.types";
import { ResolveBillingTicketFlow } from "./resolve-billing-ticket.flow";

/**
 * Deterministic Flow — cheap first-pass ticket triage. Runs the legal/
 * security pre-filter, then a cheap category classifier, before deciding
 * whether to hand off to the (more expensive) billing flow or leave the
 * ticket for a human/Mode A.
 */
@Injectable()
export class TriageTicketFlow {
  constructor(
    private readonly tickets: TicketsService,
    private readonly anthropic: AnthropicService,
    private readonly resolveBillingTicket: ResolveBillingTicketFlow,
  ) {}

  async execute(ticketId: number, actor: string): Promise<TriageTicketResult> {
    const steps: FlowStep[] = [];
    const ticket = this.tickets.getById(ticketId);

    const flags = this.tickets.checkLegalOrSecurityFlags(ticketId);
    steps.push({ step: "legal_security_prefilter", detail: { ...flags } });
    if (flags.flagged) {
      this.tickets.updateStatus(ticketId, "escalated");
      return {
        flow: "triage_ticket",
        ticket_id: ticketId,
        category: "legal",
        reasoning: `Pre-filter matched: ${flags.matched_keywords.join(", ")}`,
        billing_result: null,
        steps,
      };
    }

    // Cheap classifier before the expensive path.
    const { category, reasoning } = await classifyTicketCategory(this.anthropic, ticket);
    steps.push({ step: "classify_category", detail: { category, reasoning } });

    if (category === "legal") {
      this.tickets.updateStatus(ticketId, "escalated");
      return { flow: "triage_ticket", ticket_id: ticketId, category, reasoning, billing_result: null, steps };
    }

    if (category === "billing") {
      const billing_result = await this.resolveBillingTicket.execute(ticketId, actor);
      steps.push({ step: "handoff_to_billing_flow", detail: { decision: billing_result.decision } });
      return { flow: "triage_ticket", ticket_id: ticketId, category, reasoning, billing_result, steps };
    }

    // technical / other — no dedicated deterministic handler yet; leave for
    // Mode A or a human to pick up.
    steps.push({ step: "no_deterministic_handler", detail: { category } });
    return { flow: "triage_ticket", ticket_id: ticketId, category, reasoning, billing_result: null, steps };
  }
}
