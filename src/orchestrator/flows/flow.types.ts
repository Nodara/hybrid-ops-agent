import { User, UserSummary } from "../../users/user.types";
import { Refund, TicketMessage } from "../../support-desk/support-desk.types";

/** A single executed step in a deterministic flow, captured for observability. */
export interface FlowStep {
  step: string;
  detail?: Record<string, unknown>;
}

/** Deterministic risk score attached to a set of matched users. */
export interface RiskAssessment {
  score: number;
  level: "low" | "medium" | "high";
  signals: string[];
}

export interface SuspendByDomainResult {
  flow: "suspend_users_by_domain";
  domain: string;
  matched_count: number;
  /** Capped preview of the matched users (full list can be large). */
  matched_sample: UserSummary[];
  risk: RiskAssessment;
  decision: "escalated" | "suspended" | "no_matches";
  escalation: {
    summary: string;
    risk_level: RiskAssessment["level"];
    reasons: string[];
  } | null;
  suspended: { count: number; user_ids: number[] } | null;
  steps: FlowStep[];
}

export interface BulkCreateResult {
  flow: "bulk_create_users_from_csv";
  parsed_rows: number;
  created: User[];
  failed: { line: number; input: Record<string, string>; error: string }[];
  steps: FlowStep[];
}

/** Why a bulk-onboard row wasn't created. */
export type BulkOnboardSkipReason =
  | "invalid_format"
  | "invalid_role"
  | "duplicate_in_batch"
  | "duplicate_in_db"
  | "write_failed";

export interface BulkOnboardRowResult {
  line: number;
  email: string;
  status: "created" | "skipped";
  reason?: BulkOnboardSkipReason;
  user?: User;
}

export interface BulkOnboardResult {
  flow: "bulk_onboard_users";
  submitted_rows: number;
  /** "rejected" means the batch size cap was exceeded — nothing was processed. */
  outcome: "processed" | "rejected";
  rejection_reason?: string;
  created_count: number;
  skipped_count: number;
  results: BulkOnboardRowResult[];
  steps: FlowStep[];
}

/** A packaged escalation preserving full ticket context, not a one-line note. */
export interface TicketEscalation {
  summary: string;
  risk_level: RiskAssessment["level"];
  reasons: string[];
  full_thread: string;
}

export interface ResolveBillingTicketResult {
  flow: "resolve_billing_ticket";
  ticket_id: number;
  decision: "refunded" | "escalated" | "replied_no_refund";
  requested_amount_cents: number | null;
  refund: Refund | null;
  escalation: TicketEscalation | null;
  reply: TicketMessage | null;
  steps: FlowStep[];
}

export interface TriageTicketResult {
  flow: "triage_ticket";
  ticket_id: number;
  category: "billing" | "technical" | "legal" | "other";
  reasoning: string;
  billing_result: ResolveBillingTicketResult | null;
  steps: FlowStep[];
}

export type FlowResult =
  | SuspendByDomainResult
  | BulkCreateResult
  | BulkOnboardResult
  | ResolveBillingTicketResult
  | TriageTicketResult;
