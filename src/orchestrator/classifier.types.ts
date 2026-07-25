/** Which of the two engines the classifier routes a request to. */
export type Route = "deterministic" | "model_driven";

/** The deterministic flows the classifier can select. */
export type DeterministicFlow =
  | "suspend_users_by_domain"
  | "bulk_create_users_from_csv";

/**
 * Structured decision emitted by the classifier agent. Produced by a single
 * forced-tool Claude call, so the shape is guaranteed rather than parsed out of
 * free text.
 */
export interface ClassificationResult {
  route: Route;
  /** Set only when route === "deterministic". */
  flow: DeterministicFlow | null;
  /** Extracted parameter for suspend_users_by_domain (e.g. "acme.com"). */
  domain: string | null;
  /** Extracted parameter for bulk_create_users_from_csv (raw CSV text). */
  csv_text: string | null;
  /** The tool/step sequence the classifier expects the flow to run, for transparency. */
  tool_sequence: string[];
  /** Short natural-language justification for the routing choice. */
  reasoning: string;
}
