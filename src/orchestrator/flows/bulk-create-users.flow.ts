import { Injectable } from "@nestjs/common";
import { UsersService, UserOperationError } from "../../users/users.service";
import { Role } from "../../users/user.types";
import { BulkCreateResult, FlowStep } from "./flow.types";

interface ParsedRow {
  line: number;
  email: string;
  name: string;
  role: string;
}

/**
 * Deterministic Flow 2 — bulk-create users from CSV text.
 *
 * Fixed step sequence: parse_csv → create_users.
 * Each row is created independently; a bad row is recorded in `failed` and does
 * not abort the rest (partial success), so the operator gets one clear report.
 */
@Injectable()
export class BulkCreateUsersFlow {
  constructor(private readonly users: UsersService) {}

  /**
   * Minimal CSV parser. Accepts an optional header row (any order of the
   * email/name/role columns); if no header is present, columns are assumed to be
   * email,name,role. Handles simple double-quote wrapping but not embedded commas.
   */
  private parseCsv(text: string): ParsedRow[] {
    const lines = text
      .split(/\r?\n/)
      .map((l, i) => ({ raw: l, line: i + 1 }))
      .filter((l) => l.raw.trim().length > 0);
    if (lines.length === 0) return [];

    const cells = (raw: string) =>
      raw.split(",").map((c) => c.trim().replace(/^"(.*)"$/, "$1").trim());

    // Detect a header row by looking for the "email" column name.
    const first = cells(lines[0].raw).map((c) => c.toLowerCase());
    const hasHeader = first.includes("email");

    let idx = { email: 0, name: 1, role: 2 };
    let dataLines = lines;
    if (hasHeader) {
      idx = {
        email: first.indexOf("email"),
        name: first.indexOf("name"),
        role: first.indexOf("role"),
      };
      dataLines = lines.slice(1);
    }

    return dataLines.map(({ raw, line }) => {
      const c = cells(raw);
      const at = (i: number) => (i >= 0 && i < c.length ? c[i] : "");
      return {
        line,
        email: at(idx.email),
        name: at(idx.name),
        role: at(idx.role),
      };
    });
  }

  execute(csvText: string, actor: string): BulkCreateResult {
    const steps: FlowStep[] = [];

    const rows = this.parseCsv(csvText);
    steps.push({ step: "parse_csv", detail: { parsed_rows: rows.length } });

    const created: BulkCreateResult["created"] = [];
    const failed: BulkCreateResult["failed"] = [];

    for (const row of rows) {
      const input = { email: row.email, name: row.name, role: row.role };
      try {
        // create() validates email format, name, role, and uniqueness in code,
        // throwing UserOperationError on any violation.
        created.push(this.users.create(actor, row.email, row.name, row.role as Role));
      } catch (err) {
        const message =
          err instanceof UserOperationError
            ? err.message
            : `Unexpected error: ${(err as Error).message}`;
        failed.push({ line: row.line, input, error: message });
      }
    }

    steps.push({
      step: "create_users",
      detail: { created: created.length, failed: failed.length },
    });

    return {
      flow: "bulk_create_users_from_csv",
      parsed_rows: rows.length,
      created,
      failed,
      steps,
    };
  }
}
