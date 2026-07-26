import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { UsersService } from "../users/users.service";
import { Role } from "../users/user.types";
import { Refund } from "./support-desk.types";
import { SubscriptionsService } from "./subscriptions.service";
import { computeRefundableCeilingCents, evaluateRefundPolicy } from "./refund-policy";

export class RefundOperationError extends Error {}

/** Which roles may issue refunds — money movement, so restricted like suspend_user's peers. */
const REFUND_ALLOWED_ROLES: Role[] = ["editor", "admin"];

export type RefundPolicyEnforcementMode = "code_enforced" | "prompt_only";

@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  /**
   * Feature flag for the paired adversarial-ticket comparison: "code_enforced"
   * (default) actually rejects refunds that violate REFUND_POLICY;
   * "prompt_only" skips that check entirely (the policy text still exists
   * only in the Mode A system prompt) so the identical ticket can be run
   * through both and the difference recorded.
   */
  readonly enforcementMode: RefundPolicyEnforcementMode =
    (process.env.REFUND_POLICY_ENFORCEMENT || "code_enforced") === "prompt_only"
      ? "prompt_only"
      : "code_enforced";

  constructor(
    private readonly database: DatabaseService,
    private readonly subscriptions: SubscriptionsService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private inTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private authorize(actor: string): void {
    const role = this.users.resolveActorRole(actor);
    if (!REFUND_ALLOWED_ROLES.includes(role)) {
      throw new RefundOperationError(
        `Actor "${actor}" (role: ${role}) is not authorized to issue refunds.`,
      );
    }
  }

  issueRefund(
    actor: string,
    subscriptionId: number,
    amountCents: number,
    reason: string,
    approvalFlag: boolean,
  ): Refund {
    this.authorize(actor);

    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new RefundOperationError(`Invalid amount_cents: ${amountCents}.`);
    }
    if (!reason || !reason.trim()) {
      throw new RefundOperationError("A reason is required to issue a refund.");
    }

    const subscription = this.subscriptions.getById(subscriptionId); // throws if missing

    // Business rule 1 — refundable ceiling from remaining-term math. ALWAYS
    // enforced, independent of enforcementMode — this is a distinct business
    // rule from the dollar-threshold policy below, not a second copy of it.
    const ceiling = computeRefundableCeilingCents(subscription);
    if (amountCents > ceiling) {
      throw new RefundOperationError(
        `Refund of ${amountCents}c exceeds the refundable ceiling of ${ceiling}c for ` +
          `subscription ${subscriptionId} (remaining-term math).`,
      );
    }

    // Business rule 2 — dollar-threshold autonomy policy. Skippable via the
    // feature flag so the identical adversarial ticket can be run through
    // both variants and compared.
    if (this.enforcementMode === "code_enforced") {
      const decision = evaluateRefundPolicy(amountCents, approvalFlag);
      if (!decision.allowed) {
        throw new RefundOperationError(decision.reason);
      }
    } else {
      this.logger.warn(
        `REFUND_POLICY_ENFORCEMENT=prompt_only — skipping code-level dollar-threshold check ` +
          `for a $${(amountCents / 100).toFixed(2)} refund on subscription ${subscriptionId}.`,
      );
    }

    return this.inTransaction(() => {
      const info = this.db
        .prepare(
          "INSERT INTO refunds (subscription_id, amount_cents, reason, issued_by, approved_by) " +
            "VALUES (?, ?, ?, ?, ?)",
        )
        .run(subscriptionId, amountCents, reason.trim(), actor, approvalFlag ? actor : null);
      const refundId = Number(info.lastInsertRowid);

      // Mirror into the shared ledger so Product 3 can see it without
      // joining through Product 2's schema.
      this.db
        .prepare(
          "INSERT INTO transactions (user_id, type, amount_cents, currency, metadata) " +
            "VALUES (?, 'refund', ?, 'usd', ?)",
        )
        .run(subscription.user_id, amountCents, JSON.stringify({ refund_id: refundId }));

      this.audit.record(actor, "issue_refund", subscription.user_id, {
        refund_id: refundId,
        subscription_id: subscriptionId,
        amount_cents: amountCents,
        reason: reason.trim(),
        approval_flag: approvalFlag,
        enforcement_mode: this.enforcementMode,
      });

      return this.getById(refundId);
    });
  }

  getById(id: number): Refund {
    const refund = this.db.prepare("SELECT * FROM refunds WHERE id = ?").get(id) as
      | Refund
      | undefined;
    if (!refund) throw new RefundOperationError(`No refund found with id ${id}.`);
    return refund;
  }
}
