import { User, UserSummary } from "../../users/user.types";

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

export type FlowResult = SuspendByDomainResult | BulkCreateResult;
