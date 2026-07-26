import { Injectable, Logger } from "@nestjs/common";
import { UsersService, UserOperationError } from "../../users/users.service";
import { Role, isRole, isValidEmail } from "../../users/user.types";
import {
  BulkOnboardResult,
  BulkOnboardRowResult,
  FlowStep,
} from "./flow.types";

export interface BulkOnboardRow {
  email: string;
  name: string;
  role: string;
}

/** Reject the whole batch outright above this size rather than truncating it. */
const MAX_BATCH_SIZE = 500;

/**
 * Deterministic Flow — bulk-onboard users from a rows array (not raw CSV;
 * see `bulk_create_users_from_csv` for the CSV-text entry point).
 *
 * Two-phase, all-or-nothing by phase:
 *   1. validate_rows  — every row is checked (format, role, duplicate against
 *      both the DB and earlier rows in the same batch) BEFORE any writes
 *      happen. Rows that fail are marked `skipped` with a reason; nothing is
 *      written yet, so this phase can never leave a partial batch behind.
 *   2. create_valid_rows — every row that passed validation is created in a
 *      single atomic transaction: they all commit together, or (if something
 *      unexpected fails mid-write) none do and the whole batch rolls back.
 */
@Injectable()
export class BulkOnboardUsersFlow {
  private readonly logger = new Logger(BulkOnboardUsersFlow.name);

  constructor(private readonly users: UsersService) {}

  execute(rows: BulkOnboardRow[], actor: string): BulkOnboardResult {
    const steps: FlowStep[] = [];

    if (rows.length > MAX_BATCH_SIZE) {
      const rejection_reason = `Batch of ${rows.length} rows exceeds the cap of ${MAX_BATCH_SIZE}; submit smaller batches.`;
      this.logger.warn(`REJECTED bulk_onboard_users: ${rejection_reason}`);
      steps.push({
        step: "validate_batch_size",
        detail: { rejected: true, reason: rejection_reason },
      });
      return {
        flow: "bulk_onboard_users",
        submitted_rows: rows.length,
        outcome: "rejected",
        rejection_reason,
        created_count: 0,
        skipped_count: 0,
        results: [],
        steps,
      };
    }

    // Phase 1 — validate every row before writing any.
    const seenInBatch = new Set<string>();
    const results: BulkOnboardRowResult[] = [];
    const toCreate: { line: number; email: string; name: string; role: Role }[] =
      [];

    rows.forEach((row, idx) => {
      const line = idx + 1;
      const email = (row.email ?? "").trim().toLowerCase();
      const name = (row.name ?? "").trim();

      if (!isValidEmail(email) || !name) {
        results.push({ line, email, status: "skipped", reason: "invalid_format" });
        return;
      }
      if (!isRole(row.role)) {
        results.push({ line, email, status: "skipped", reason: "invalid_role" });
        return;
      }
      if (seenInBatch.has(email)) {
        results.push({
          line,
          email,
          status: "skipped",
          reason: "duplicate_in_batch",
        });
        return;
      }
      if (this.users.emailExists(email)) {
        results.push({ line, email, status: "skipped", reason: "duplicate_in_db" });
        return;
      }

      seenInBatch.add(email);
      toCreate.push({ line, email, name, role: row.role });
      // Placeholder — replaced with the created record (or a write_failed
      // skip) once phase 2 runs. Keeps `results` in submission order.
      results.push({ line, email, status: "created" });
    });

    steps.push({
      step: "validate_rows",
      detail: { valid: toCreate.length, skipped: results.length - toCreate.length },
    });

    // Phase 2 — create every validated row atomically: all or none.
    if (toCreate.length > 0) {
      try {
        this.users.runAtomically(() => {
          for (const row of toCreate) {
            const created = this.users.create(actor, row.email, row.name, row.role);
            const slot = results.find(
              (r) => r.line === row.line && r.status === "created",
            );
            if (slot) slot.user = created;
          }
        });
      } catch (err) {
        // The transaction rolled back — none of `toCreate` was persisted.
        // Re-mark every row we had planned to create as failed.
        const message =
          err instanceof UserOperationError
            ? err.message
            : `Unexpected error: ${(err as Error).message}`;
        this.logger.warn(`bulk_onboard_users write phase rolled back: ${message}`);
        for (const row of toCreate) {
          const slot = results.find((r) => r.line === row.line);
          if (slot) {
            slot.status = "skipped";
            slot.reason = "write_failed";
            delete slot.user;
          }
        }
      }
    }

    const created_count = results.filter((r) => r.status === "created").length;
    const skipped_count = results.length - created_count;
    steps.push({
      step: "create_valid_rows",
      detail: { created: created_count, skipped: skipped_count },
    });

    return {
      flow: "bulk_onboard_users",
      submitted_rows: rows.length,
      outcome: "processed",
      created_count,
      skipped_count,
      results,
      steps,
    };
  }
}
