import { Injectable, Logger } from "@nestjs/common";
import { AgentService, AgentRunResult } from "../agent/agent.service";
import { ClassifierService } from "./classifier.service";
import { ClassificationResult } from "./classifier.types";
import { SuspendByDomainFlow } from "./flows/suspend-by-domain.flow";
import { BulkCreateUsersFlow } from "./flows/bulk-create-users.flow";
import { FlowResult } from "./flows/flow.types";

export interface OrchestrationResult {
  classification: ClassificationResult;
  /** The engine actually used — may differ from the classifier if it fell back. */
  route: "deterministic" | "model_driven";
  flow: ClassificationResult["flow"];
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
    private readonly agent: AgentService,
  ) {}

  async run(prompt: string, actor: string): Promise<OrchestrationResult> {
    const classification = await this.classifier.classify(prompt);

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
