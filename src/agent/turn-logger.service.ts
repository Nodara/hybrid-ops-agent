import { Injectable, Logger } from '@nestjs/common';

export interface ToolCallLog {
  name: string;
  arguments: Record<string, unknown>;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** One iteration of the Mode A loop, captured for observability. */
export interface TurnLog {
  turn: number;
  stop_reason: string | null;
  usage: TokenUsage;
  thinking?: string;
  text?: string;
  tool_calls: ToolCallLog[];
}

/**
 * Emits a structured, human-readable line for every model turn: which tools were
 * called (with arguments), why the model stopped, and token counts.
 */
@Injectable()
export class TurnLogger {
  private readonly logger = new Logger('AgentTurn');

  log(turn: TurnLog): void {
    const tools =
      turn.tool_calls.length > 0
        ? turn.tool_calls
            .map((t) => `${t.name}(${JSON.stringify(t.arguments)})`)
            .join(', ')
        : '<none>';

    const u = turn.usage;
    this.logger.log(
      `turn=${turn.turn} stop_reason=${turn.stop_reason} ` +
        `tools=[${tools}] ` +
        `tokens{in=${u.input_tokens},out=${u.output_tokens},` +
        `cache_read=${u.cache_read_input_tokens},cache_write=${u.cache_creation_input_tokens}}`,
    );
  }
}
