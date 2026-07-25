import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { OrchestratorService } from "./orchestrator.service";
import { ClassifierService } from "./classifier.service";

interface OrchestrateRequest {
  prompt: string;
  /** Ops user on whose behalf the flow/agent acts; recorded in the audit log. */
  actor?: string;
}

@Controller("orchestrate")
export class OrchestratorController {
  constructor(
    private readonly orchestrator: OrchestratorService,
    private readonly classifier: ClassifierService,
  ) {}

  /** Classify the request and run whichever engine the classifier selects. */
  @Post()
  @HttpCode(200)
  async run(@Body() body: OrchestrateRequest) {
    const prompt = (body?.prompt ?? "").trim();
    if (!prompt) {
      return { error: 'A non-empty "prompt" is required.' };
    }
    const actor = (body?.actor ?? "ops-console").trim() || "ops-console";
    return this.orchestrator.run(prompt, actor);
  }

  /** Classify only — see the routing decision without executing anything. */
  @Post("classify")
  @HttpCode(200)
  async classify(@Body() body: OrchestrateRequest) {
    const prompt = (body?.prompt ?? "").trim();
    if (!prompt) {
      return { error: 'A non-empty "prompt" is required.' };
    }
    return this.classifier.classify(prompt);
  }
}
