import { UserSummary } from "../../users/user.types";
import { RiskAssessment } from "./flow.types";

/**
 * Deterministic risk scoring for a domain-wide suspension. Kept as a pure
 * function so the flow stays fully deterministic and unit-testable — this is
 * the "generate risk assessment score" step. Swap the body for a model call if
 * a qualitative assessment is ever wanted; the flow only depends on the shape.
 *
 * Signals that raise risk: privileged roles (admins weigh heavily, editors
 * moderately), the sheer size of the blast radius, and how many of the matched
 * accounts are currently active (i.e. real disruption).
 */
export function assessDomainRisk(users: UserSummary[]): RiskAssessment {
  const signals: string[] = [];
  let score = 0;

  const admins = users.filter((u) => u.role === "admin").length;
  const editors = users.filter((u) => u.role === "editor").length;
  const active = users.filter((u) => u.status === "active").length;

  if (admins > 0) {
    score += admins * 40;
    signals.push(`${admins} admin account(s) in scope`);
  }
  if (editors > 0) {
    score += editors * 10;
    signals.push(`${editors} editor account(s) in scope`);
  }

  // Blast radius: grows with match count but saturates so one giant domain
  // doesn't drown out the role signal.
  score += Math.min(users.length, 25) * 2;
  if (users.length > 10) {
    signals.push(`${users.length} accounts matched (large blast radius)`);
  }

  if (active > 0) {
    score += Math.min(active, 20);
    signals.push(`${active} currently-active account(s) would be disrupted`);
  }

  const level: RiskAssessment["level"] =
    score >= 70 ? "high" : score >= 35 ? "medium" : "low";

  return { score, level, signals };
}
