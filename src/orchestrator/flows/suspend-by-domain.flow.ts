import { Injectable, Logger } from "@nestjs/common";
import { UsersService } from "../../users/users.service";
import { UserSummary } from "../../users/user.types";
import { assessDomainRisk } from "./risk-assessment";
import { FlowStep, SuspendByDomainResult } from "./flow.types";

/** Escalate instead of suspending when MORE THAN this many users match. */
const MAX_AUTO_SUSPEND = 3;
/**
 * Hard ceiling on how many users this flow will ever suspend in a single
 * invocation — independent of the risk-escalation gate above (MAX_AUTO_SUSPEND
 * is meant to be crossed and tuned; this is a backstop that should not move
 * with it). Two separate guardrails, not one: even if the escalation gate is
 * ever loosened or misconfigured, this still blocks a runaway blast radius.
 */
const MAX_SUSPEND_PER_INVOCATION = 50;
/** How many matched users to echo back in the result preview. */
const SAMPLE_SIZE = 20;

/**
 * Deterministic Flow 1 — suspend every user in an email domain.
 *
 * Fixed step sequence (control flow is code, not model-decided):
 *   1. find_users_by_domain
 *   2. assess_risk        (deterministic score)
 *   3. escalate_or_suspend:
 *        escalate to a human if ANY of:
 *          - more than MAX_AUTO_SUSPEND users match, OR
 *          - any matched user is an admin, OR
 *          - the risk level is "high", OR
 *          - more than MAX_SUSPEND_PER_INVOCATION users match (hard ceiling)
 *        otherwise suspend each matched user.
 */
@Injectable()
export class SuspendByDomainFlow {
  private readonly logger = new Logger(SuspendByDomainFlow.name);

  constructor(private readonly users: UsersService) {}

  private escalate(
    domain: string,
    matched: UserSummary[],
    matched_sample: SuspendByDomainResult["matched_sample"],
    risk: SuspendByDomainResult["risk"],
    reasons: string[],
    steps: FlowStep[],
  ): SuspendByDomainResult {
    const summary =
      `Requested suspension of all users at "${domain}" ` +
      `(${matched.length} matched) requires human approval: ${reasons.join("; ")}.`;
    this.logger.warn(`ESCALATION [${risk.level}] ${summary}`);
    steps.push({
      step: "escalate_or_suspend",
      detail: { decision: "escalated", reasons },
    });
    return {
      flow: "suspend_users_by_domain",
      domain,
      matched_count: matched.length,
      matched_sample,
      risk,
      decision: "escalated",
      escalation: { summary, risk_level: risk.level, reasons },
      suspended: null,
      steps,
    };
  }

  /** Normalize "@Acme.com", "user@acme.com", "ACME.COM" → "acme.com". */
  private normalizeDomain(raw: string): string {
    const trimmed = raw
      .trim()
      .toLowerCase()
      .replace(/^mailto:/, "");
    const afterAt = trimmed.includes("@")
      ? trimmed.slice(trimmed.lastIndexOf("@") + 1)
      : trimmed;
    return afterAt.replace(/^@+/, "").replace(/\/+$/, "");
  }

  execute(rawDomain: string, actor: string): SuspendByDomainResult {
    const steps: FlowStep[] = [];
    const domain = this.normalizeDomain(rawDomain);

    // Step 1 — find users by domain.
    const matched = this.users.findByDomain(domain);
    steps.push({
      step: "find_users_by_domain",
      detail: { domain, matched_count: matched.length },
    });

    const matched_sample = matched.slice(0, SAMPLE_SIZE);

    if (matched.length === 0) {
      return {
        flow: "suspend_users_by_domain",
        domain,
        matched_count: 0,
        matched_sample,
        risk: { score: 0, level: "low", signals: ["no matching users"] },
        decision: "no_matches",
        escalation: null,
        suspended: null,
        steps,
      };
    }

    // Step 2 — generate risk assessment score.
    const risk = assessDomainRisk(matched);
    steps.push({
      step: "assess_risk",
      detail: { score: risk.score, level: risk.level },
    });

    // Step 3 — decision gate.
    const admins = matched.filter((u) => u.role === "admin");
    const reasons: string[] = [];
    if (matched.length > MAX_AUTO_SUSPEND) {
      reasons.push(
        `${matched.length} users match (> ${MAX_AUTO_SUSPEND} auto-suspend limit)`,
      );
    }
    if (admins.length > 0) {
      reasons.push(`${admins.length} matched user(s) are admins`);
    }
    if (risk.level === "high") {
      reasons.push(`risk level is high (score ${risk.score})`);
    }

    if (reasons.length > 0) {
      return this.escalate(domain, matched, matched_sample, risk, reasons, steps);
    }

    // Independent hard ceiling, checked separately from the reasons-based
    // gate above so it still applies even if that gate's logic changes.
    if (matched.length > MAX_SUSPEND_PER_INVOCATION) {
      return this.escalate(
        domain,
        matched,
        matched_sample,
        risk,
        [
          `${matched.length} users match (> ${MAX_SUSPEND_PER_INVOCATION} hard suspend ceiling)`,
        ],
        steps,
      );
    }

    // Safe to auto-suspend: small, no admins, not high risk.
    const reason = `Bulk domain suspension of ${domain} (deterministic flow).`;
    const user_ids: number[] = [];
    for (const u of matched) {
      // Deleted accounts are left alone — suspending a deleted account isn't
      // meaningful. Already-suspended accounts still go through suspend(),
      // which is idempotent: it no-ops the row update but still logs the
      // attempt (retries/double-runs of this flow shouldn't go unaudited).
      if (u.status === "deleted") continue;
      this.users.suspend(actor, u.id, reason);
      user_ids.push(u.id);
    }
    steps.push({
      step: "escalate_or_suspend",
      detail: { decision: "suspended", suspended_count: user_ids.length },
    });

    return {
      flow: "suspend_users_by_domain",
      domain,
      matched_count: matched.length,
      matched_sample,
      risk,
      decision: "suspended",
      escalation: null,
      suspended: { count: user_ids.length, user_ids },
      steps,
    };
  }
}
