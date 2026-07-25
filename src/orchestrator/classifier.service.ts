import { Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicService } from "../llm/anthropic.service";
import { ClassificationResult } from "./classifier.types";

const CLASSIFIER_TOOL_NAME = "route_request";

const SYSTEM_PROMPT = `You are the router for an internal user-administration copilot.
Analyse the operator's request and decide how it should be handled. You do NOT
perform the work — you only classify and extract parameters.

There are exactly two deterministic flows. Choose one ONLY when the request
clearly matches it and you can extract its required parameter:

1. "suspend_users_by_domain" — the operator wants to suspend / disable / offboard
   every user belonging to an email domain (e.g. "suspend everyone at acme.com").
   Required parameter: "domain" (bare domain such as "acme.com"; strip any leading
   "@" or "mailto:"; if given a full email, use the part after the "@").

2. "bulk_create_users_from_csv" — the operator provides CSV text (header or rows
   with email/name/role) and wants those users created in bulk.
   Required parameter: "csv_text" (the raw CSV content, verbatim).

For anything else — single-user actions, searches, updates, ambiguous or
multi-step requests, or a deterministic flow whose required parameter is missing —
choose route "model_driven" and leave flow/domain/csv_text null.

Always call the ${CLASSIFIER_TOOL_NAME} tool exactly once. In tool_sequence,
list the deterministic steps you expect (for suspend_users_by_domain:
["find_users_by_domain","assess_risk","escalate_or_suspend"]; for
bulk_create_users_from_csv: ["parse_csv","create_users"]; for model_driven: []).`;

const CLASSIFIER_TOOL: Anthropic.Tool = {
  name: CLASSIFIER_TOOL_NAME,
  description:
    "Record the routing decision for the operator's request. Must be called once.",
  input_schema: {
    type: "object",
    properties: {
      route: {
        type: "string",
        enum: ["deterministic", "model_driven"],
        description: "Which engine handles the request.",
      },
      flow: {
        type: ["string", "null"],
        enum: ["suspend_users_by_domain", "bulk_create_users_from_csv", null],
        description:
          "The deterministic flow to run. Null when route is model_driven.",
      },
      domain: {
        type: ["string", "null"],
        description:
          "Bare email domain for suspend_users_by_domain, else null.",
      },
      csv_text: {
        type: ["string", "null"],
        description:
          "Raw CSV content for bulk_create_users_from_csv, else null.",
      },
      tool_sequence: {
        type: "array",
        items: { type: "string" },
        description: "Ordered steps the chosen flow is expected to run.",
      },
      reasoning: {
        type: "string",
        description: "One or two sentences explaining the routing choice.",
      },
    },
    required: ["route", "flow", "domain", "csv_text", "tool_sequence", "reasoning"],
  },
};

/**
 * The classifier agent. A single Claude call with tool_choice forced to
 * route_request yields a structured routing decision (no free-text parsing).
 */
@Injectable()
export class ClassifierService {
  private readonly logger = new Logger(ClassifierService.name);
  private readonly maxTokens = Number(process.env.CLASSIFIER_MAX_TOKENS) || 1024;

  constructor(private readonly anthropic: AnthropicService) {}

  async classify(prompt: string): Promise<ClassificationResult> {
    const response = await this.anthropic.getClient().messages.create({
      model: this.anthropic.model,
      max_tokens: this.maxTokens,
      system: SYSTEM_PROMPT,
      tools: [CLASSIFIER_TOOL],
      // Force the model to answer through the schema — guarantees structure.
      tool_choice: { type: "tool", name: CLASSIFIER_TOOL_NAME },
      messages: [{ role: "user", content: prompt }],
    });

    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === "tool_use" && b.name === CLASSIFIER_TOOL_NAME,
    );

    if (!toolUse) {
      // Should not happen with a forced tool, but fail safe to the model-driven
      // engine rather than guessing a deterministic action.
      this.logger.warn(
        "Classifier did not return a routing tool call; defaulting to model_driven.",
      );
      return {
        route: "model_driven",
        flow: null,
        domain: null,
        csv_text: null,
        tool_sequence: [],
        reasoning: "Classifier returned no decision; defaulted to model-driven.",
      };
    }

    const input = (toolUse.input ?? {}) as Record<string, unknown>;
    const result: ClassificationResult = {
      route: input.route === "deterministic" ? "deterministic" : "model_driven",
      flow:
        input.flow === "suspend_users_by_domain" ||
        input.flow === "bulk_create_users_from_csv"
          ? input.flow
          : null,
      domain: typeof input.domain === "string" ? input.domain : null,
      csv_text: typeof input.csv_text === "string" ? input.csv_text : null,
      tool_sequence: Array.isArray(input.tool_sequence)
        ? input.tool_sequence.filter((s): s is string => typeof s === "string")
        : [],
      reasoning: typeof input.reasoning === "string" ? input.reasoning : "",
    };

    this.logger.log(
      `route=${result.route} flow=${result.flow ?? "-"} ` +
        `domain=${result.domain ?? "-"} csv=${result.csv_text ? "yes" : "no"}`,
    );
    return result;
  }
}
