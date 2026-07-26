import { Injectable, Logger } from "@nestjs/common";
import { AgentService, AgentRunResult } from "../agent/agent.service";
import { ClassifierService } from "./classifier.service";
import { ClassificationResult } from "./classifier.types";
import { SuspendByDomainFlow } from "./flows/suspend-by-domain.flow";
import { BulkCreateUsersFlow } from "./flows/bulk-create-users.flow";
import { ResolveBillingTicketFlow } from "./flows/resolve-billing-ticket.flow";
import { TriageTicketFlow } from "./flows/triage-ticket.flow";
import { FlowResult, TriageTicketResult } from "./flows/flow.types";
import { TicketsService } from "../support-desk/tickets.service";

export interface OrchestrationResult {
  classification: ClassificationResult;
  /** The engine actually used — may differ from the classifier if it fell back. */
  route: "deterministic" | "model_driven";
  /** Reflects whichever flow actually ran — wider than what the classifier can select. */
  flow: FlowResult["flow"] | null;
  /** Present when a deterministic flow ran. */
  flow_result: FlowResult | null;
  /** Present when the model-driven (Mode A) engine ran. */
  agent_result: AgentRunResult | null;
}

/**
 * Top-level router. Every request is first sent to the classifier agent; its
 * decision selects a deterministic flow or the model-driven engine (Mode A).
 *
 * Safety rule: if the classifier picks a deterministic flow but the required
 * parameter is missing, we do NOT guess — we fall back to the model-driven
 * engine, which can ask the operator for clarification.
 */
@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(
    private readonly classifier: ClassifierService,
    private readonly suspendByDomain: SuspendByDomainFlow,
    private readonly bulkCreate: BulkCreateUsersFlow,
    private readonly resolveBillingTicket: ResolveBillingTicketFlow,
    private readonly triageTicket: TriageTicketFlow,
    private readonly tickets: TicketsService,
    private readonly agent: AgentService,
  ) {}

  async run(prompt: string, actor: string): Promise<OrchestrationResult> {
    const classification = await this.classifier.classify(prompt);

    // Universal pre-dispatch guardrail: whenever a specific ticket is
    // referenced, run the legal/security pre-filter immediately — before
    // EITHER a deterministic flow or Mode A ever sees the ticket, regardless
    // of route. This closes the gap a flow-level pre-filter alone wouldn't
    // cover (a ticket-referencing prompt classified as model_driven).
    if (classification.ticket_id !== null) {
      const flags = this.tickets.checkLegalOrSecurityFlags(classification.ticket_id);
      if (flags.flagged) {
        this.tickets.updateStatus(classification.ticket_id, "escalated");
        const flow_result = this.legalPrefilterResult(
          classification.ticket_id,
          flags.matched_keywords,
        );
        return this.result(classification, "deterministic", flow_result, null);
      }
    }

    if (classification.route === "deterministic") {
      if (
        classification.flow === "suspend_users_by_domain" &&
        classification.domain?.trim()
      ) {
        const flow_result = this.suspendByDomain.execute(
          classification.domain,
          actor,
        );
        return this.result(classification, "deterministic", flow_result, null);
      }

      if (
        classification.flow === "bulk_create_users_from_csv" &&
        classification.csv_text?.trim()
      ) {
        const flow_result = this.bulkCreate.execute(
          classification.csv_text,
          actor,
        );
        return this.result(classification, "deterministic", flow_result, null);
      }

      if (
        classification.flow === "resolve_billing_ticket" &&
        classification.ticket_id !== null
      ) {
        const flow_result = await this.resolveBillingTicket.execute(
          classification.ticket_id,
          actor,
        );
        return this.result(classification, "deterministic", flow_result, null);
      }

      if (
        classification.flow === "triage_ticket" &&
        classification.ticket_id !== null
      ) {
        const flow_result = await this.triageTicket.execute(
          classification.ticket_id,
          actor,
        );
        return this.result(classification, "deterministic", flow_result, null);
      }

      // Deterministic route chosen but unusable (missing/invalid param) — fall
      // back to the model-driven engine rather than acting on a guess.
      this.logger.warn(
        `Deterministic flow "${classification.flow}" selected without a usable ` +
          `parameter; falling back to model-driven.`,
      );
    }

    const agent_result = await this.agent.run(prompt, actor);
    return this.result(classification, "model_driven", null, agent_result);
  }

  private legalPrefilterResult(ticketId: number, matched: string[]): TriageTicketResult {
    return {
      flow: "triage_ticket",
      ticket_id: ticketId,
      category: "legal",
      reasoning: `Pre-filter matched: ${matched.join(", ")}`,
      billing_result: null,
      steps: [
        {
          step: "legal_security_prefilter",
          detail: { flagged: true, matched_keywords: matched },
        },
      ],
    };
  }

  private result(
    classification: ClassificationResult,
    route: OrchestrationResult["route"],
    flow_result: FlowResult | null,
    agent_result: AgentRunResult | null,
  ): OrchestrationResult {
    return {
      classification,
      route,
      flow: flow_result ? flow_result.flow : null,
      flow_result,
      agent_result,
    };
  }
}
