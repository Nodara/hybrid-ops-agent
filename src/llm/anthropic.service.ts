import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Owns the Anthropic client. Constructed lazily so the app can boot (and serve
 * read-only inspection routes) even when ANTHROPIC_API_KEY is not set — the SDK
 * constructor throws when no credential is found.
 *
 * Shared by every model-calling service (the Mode A agent and the classifier)
 * so there is a single place that resolves the credential and default model.
 */
@Injectable()
export class AnthropicService {
  private client: Anthropic | null = null;

  readonly model = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

  getClient(): Anthropic {
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
}
