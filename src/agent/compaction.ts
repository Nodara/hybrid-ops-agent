import Anthropic from "@anthropic-ai/sdk";

/**
 * Replaces all but the most recent `keepPairs` (assistant, user) turn-pairs
 * with two synthetic messages that preserve strict user/assistant role
 * alternation, which the Messages API requires: the original first message
 * (index 0 — the operator's prompt) is always kept, followed by a synthetic
 * assistant "summary" turn and a synthetic user "acknowledgment" turn, then
 * the most recent kept pairs verbatim (including their thinking/tool blocks).
 */
export function compactMessages(
  messages: Anthropic.MessageParam[],
  summaryText: string,
  keepPairs: number,
): Anthropic.MessageParam[] {
  const pairCount = Math.floor((messages.length - 1) / 2);
  const keep = Math.max(0, Math.min(keepPairs, pairCount));
  const keptSuffix = keep > 0 ? messages.slice(messages.length - keep * 2) : [];

  return [
    messages[0],
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `[Context compacted] Summary of earlier activity:\n${summaryText}`,
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "text", text: "Understood — continue from that summary." }],
    },
    ...keptSuffix,
  ];
}

/** Flattens the message/content-block history into plain text for the summarizer call. */
export function renderTranscriptForSummary(messages: Anthropic.MessageParam[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      lines.push(`[${message.role}] ${message.content}`);
      continue;
    }
    for (const block of message.content as unknown as Array<Record<string, unknown>>) {
      switch (block.type) {
        case "text":
          lines.push(`[${message.role} text] ${block.text as string}`);
          break;
        case "tool_use":
          lines.push(
            `[${message.role} tool_use] ${block.name as string}(${JSON.stringify(block.input)})`,
          );
          break;
        case "tool_result": {
          const content =
            typeof block.content === "string" ? block.content : JSON.stringify(block.content);
          lines.push(`[${message.role} tool_result] ${content}`);
          break;
        }
        case "thinking":
          lines.push(`[${message.role} thinking] ${block.thinking as string}`);
          break;
        default:
          break;
      }
    }
  }
  return lines.join("\n");
}
