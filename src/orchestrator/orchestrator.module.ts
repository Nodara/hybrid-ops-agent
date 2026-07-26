import { Module } from "@nestjs/common";
import { UsersModule } from "../users/users.module";
import { AgentModule } from "../agent/agent.module";
import { LlmModule } from "../llm/llm.module";
import { SupportDeskModule } from "../support-desk/support-desk.module";
import { ClassifierService } from "./classifier.service";
import { OrchestratorService } from "./orchestrator.service";
import { OrchestratorController } from "./orchestrator.controller";
import { FlowsController } from "./flows.controller";
import { SuspendByDomainFlow } from "./flows/suspend-by-domain.flow";
import { BulkCreateUsersFlow } from "./flows/bulk-create-users.flow";
import { BulkOnboardUsersFlow } from "./flows/bulk-onboard-users.flow";
import { ResolveBillingTicketFlow } from "./flows/resolve-billing-ticket.flow";
import { TriageTicketFlow } from "./flows/triage-ticket.flow";

/**
 * Hybrid orchestration: a classifier agent routes each request to one of
 * several deterministic flows or to the model-driven (Mode A) agent.
 */
@Module({
  imports: [UsersModule, AgentModule, LlmModule, SupportDeskModule],
  providers: [
    ClassifierService,
    OrchestratorService,
    SuspendByDomainFlow,
    BulkCreateUsersFlow,
    BulkOnboardUsersFlow,
    ResolveBillingTicketFlow,
    TriageTicketFlow,
  ],
  controllers: [OrchestratorController, FlowsController],
})
export class OrchestratorModule {}
