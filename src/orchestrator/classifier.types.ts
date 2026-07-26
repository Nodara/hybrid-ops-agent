/** Which of the two engines the classifier routes a request to. */
export type Route = "deterministic" | "model_driven";

/** The deterministic flows the classifier can select. */
export type DeterministicFlow =
  | "suspend_users_by_domain"
  | "bulk_create_users_from_csv"
  | "resolve_billing_ticket"
  | "triage_ticket";

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
  /**
   * Extracted whenever the request references a specific SupportDesk ticket,
   * regardless of which route/flow is ultimately chosen — used both for
   * resolve_billing_ticket/triage_ticket and for the universal pre-dispatch
   * legal/security guardrail in OrchestratorService.
   */
  ticket_id: number | null;
  /** The tool/step sequence the classifier expects the flow to run, for transparency. */
  tool_sequence: string[];
  /** Short natural-language justification for the routing choice. */
  reasoning: string;
}
