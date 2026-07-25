import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { UsersService } from "../users/users.service";
import { TurnLogger, TurnLog, ToolCallLog } from "./turn-logger.service";
import { ESCALATE_TOOL_NAME, TOOL_DEFINITIONS, executeTool } from "./tools";

// const SYSTEM_PROMPT = `You are UserAdmin, an internal copilot for operations staff who manage user accounts.

// You have tools to search, read, create, update, and suspend users backed by a database. Every mutating action is written to an audit log automatically.

// Guidelines:
// - Work from real data. Look users up (search_users / get_user) before acting on them; never invent ids.
// - Make the smallest change that satisfies the request. Use update_user for partial edits.
// - suspend_user requires a reason — capture a real one from the operator's request or infer a clear, specific one.
// - Do NOT validate email formatting yourself; the create_user/update_user tools enforce it and will return an error you can relay.
// - If a tool returns an error, read it and either correct the call or explain the problem to the operator.
// - Use escalate_to_human for anything dangerous, ambiguous, or beyond an ops copilot's authority: bulk or irreversible deletions, granting admin privileges, anything that looks like account takeover, or requests you cannot safely fulfill. Escalating ends the session.
// - When finished, give the operator a short, plain-language summary of what you did.`;

const SYSTEM_PROMPT = `You are UserAdmin, an internal copilot for operations staff who manage user accounts.`;

export interface AgentRunResult {
  final_text: string;
  escalation: { summary: string; risk_level: string } | null;
  stop_reason: string | null;
  iterations: number;
  turns: TurnLog[];
}

/**
 * Mode A (model-driven): Claude is given ALL tools with tool_choice: auto and
 * decides what to do. We run the tool loop by hand so we can log every turn and
 * terminate cleanly when the model escalates.
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private client: Anthropic | null = null;

  private readonly model = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
  private readonly maxTokens = Number(process.env.MAX_TOKENS) || 4096;
  private readonly maxIterations = Number(process.env.MAX_ITERATIONS) || 12;
  private readonly thinkingOn =
    (process.env.THINKING || "on").toLowerCase() !== "off";

  constructor(
    private readonly users: UsersService,
    private readonly turnLogger: TurnLogger,
  ) {}

  /**
   * Lazily construct the client so the app can boot (and serve the read-only
   * inspection routes) even when ANTHROPIC_API_KEY is not yet set — the SDK
   * constructor throws when no credential is found.
   */
  private getClient(): Anthropic {
    if (!this.client) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new ServiceUnavailableException(
          "ANTHROPIC_API_KEY is not set. Add it to your environment (.env) and restart.",
        );
      }
      // Reads ANTHROPIC_API_KEY from the environment.
      this.client = new Anthropic();
    }
    return this.client;
  }

  async run(prompt: string, actor: string): Promise<AgentRunResult> {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: prompt },
    ];
    const turns: TurnLog[] = [];
    let finalText = "";
    let escalation: AgentRunResult["escalation"] = null;
    let lastStopReason: string | null = null;

    for (let turn = 1; turn <= this.maxIterations; turn++) {
      const request: Anthropic.MessageCreateParamsNonStreaming = {
        model: this.model,
        max_tokens: this.maxTokens,
        system: SYSTEM_PROMPT,
        tools: TOOL_DEFINITIONS,
        tool_choice: { type: "auto" },
        messages,
        ...(this.thinkingOn
          ? { thinking: { type: "adaptive", display: "summarized" } }
          : {}),
      };

      const response = await this.getClient().messages.create(request);
      lastStopReason = response.stop_reason;

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      const thinking = response.content
        .filter((b): b is Anthropic.ThinkingBlock => b.type === "thinking")
        .map((b) => b.thinking)
        .join("\n")
        .trim();

      const toolCalls: ToolCallLog[] = toolUses.map((t) => ({
        name: t.name,
        arguments: (t.input ?? {}) as Record<string, unknown>,
      }));

      const turnLog: TurnLog = {
        turn,
        stop_reason: response.stop_reason,
        usage: {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens:
            response.usage.cache_creation_input_tokens ?? 0,
        },
        ...(thinking ? { thinking } : {}),
        ...(text ? { text } : {}),
        tool_calls: toolCalls,
      };
      turns.push(turnLog);
      this.turnLogger.log(turnLog);

      // Preserve the full assistant turn (including thinking blocks) for replay.
      messages.push({ role: "assistant", content: response.content });

      // Model produced a final answer (or hit a non-tool stop) — done.
      if (response.stop_reason !== "tool_use") {
        finalText = text;
        break;
      }

      // escalate_to_human terminates the loop: no tool_result is returned.
      const escalateCall = toolUses.find((t) => t.name === ESCALATE_TOOL_NAME);
      if (escalateCall) {
        const input = (escalateCall.input ?? {}) as Record<string, unknown>;
        escalation = {
          summary: String(input.summary ?? ""),
          risk_level: String(input.risk_level ?? "unknown"),
        };
        finalText = text || `Escalated to a human (${escalation.risk_level}).`;
        this.logger.warn(
          `ESCALATION [${escalation.risk_level}] ${escalation.summary}`,
        );
        break;
      }

      // Execute the remaining tools and feed all results back in one user turn.
      const toolResults: Anthropic.ToolResultBlockParam[] = toolUses.map(
        (tu) => {
          const result = executeTool(
            this.users,
            actor,
            tu.name,
            (tu.input ?? {}) as Record<string, unknown>,
          );
          return {
            type: "tool_result",
            tool_use_id: tu.id,
            content: result.content,
            is_error: result.isError,
          };
        },
      );

      messages.push({ role: "user", content: toolResults });

      if (turn === this.maxIterations) {
        finalText =
          text ||
          "Reached the maximum number of reasoning steps without a final answer.";
      }
    }

    return {
      final_text: finalText,
      escalation,
      stop_reason: lastStopReason,
      iterations: turns.length,
      turns,
    };
  }
}
