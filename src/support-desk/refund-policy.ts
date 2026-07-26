import { Subscription } from "./support-desk.types";

/**
 * Policy as data, not prompt text — RefundsService.issueRefund reads this
 * object directly and rejects calls that exceed it (in "code_enforced" mode;
 * see refunds.service.ts). Swap/extend this object, not prose, to change the
 * policy.
 */
export const REFUND_POLICY = {
  autoApproveMaxCents: 5000,
  requiresApprovalMaxCents: 20000,
} as const;

export type RefundPolicyDecision = { allowed: true } | { allowed: false; reason: string };

/** Dollar-threshold policy layer. Independent of the refundable-ceiling check below. */
export function evaluateRefundPolicy(
  amountCents: number,
  approvalFlag: boolean,
): RefundPolicyDecision {
  if (amountCents <= REFUND_POLICY.autoApproveMaxCents) {
    return { allowed: true };
  }
  if (amountCents <= REFUND_POLICY.requiresApprovalMaxCents) {
    if (approvalFlag) return { allowed: true };
    return {
      allowed: false,
      reason:
        `Refund of ${amountCents}c is above the auto-approve limit ` +
        `(${REFUND_POLICY.autoApproveMaxCents}c) and requires approval_flag=true.`,
    };
  }
  return {
    allowed: false,
    reason:
      `Refund of ${amountCents}c exceeds the maximum allowed ` +
      `(${REFUND_POLICY.requiresApprovalMaxCents}c) even with approval.`,
  };
}

const BILLING_PERIOD_DAYS = 30;
const MS_PER_DAY = 86_400_000;

/**
 * Independent business rule: the refundable ceiling from remaining-term math
 * (mrr_cents prorated by days left in the current billing period), unrelated
 * to REFUND_POLICY's dollar thresholds. Assumes a uniform 30-day billing
 * period for every plan (the schema has no per-plan period column).
 */
export function computeRefundableCeilingCents(
  subscription: Pick<Subscription, "mrr_cents" | "renewed_at">,
  now: Date = new Date(),
): number {
  const renewedAt = new Date(subscription.renewed_at.replace(" ", "T") + "Z");
  if (Number.isNaN(renewedAt.getTime())) return 0;
  const elapsedDays = Math.floor((now.getTime() - renewedAt.getTime()) / MS_PER_DAY);
  const remainingDays = Math.max(0, Math.min(BILLING_PERIOD_DAYS, BILLING_PERIOD_DAYS - elapsedDays));
  return Math.round((subscription.mrr_cents * remainingDays) / BILLING_PERIOD_DAYS);
}
