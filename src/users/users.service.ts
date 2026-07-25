import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import {
  Role,
  Status,
  UpdatableUserFields,
  User,
  UserSummary,
  isRole,
  isStatus,
  isValidEmail,
} from "./user.types";

/**
 * A user-facing validation / lookup failure. The agent tool layer catches this
 * and returns it to Claude as an `is_error` tool_result, so the model can react
 * (e.g. ask the operator to correct an email) rather than the loop crashing.
 */
export class UserOperationError extends Error {}

@Injectable()
export class UsersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  search(query: string, role?: Role, status?: Status): UserSummary[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    const q = (query ?? "").trim();
    if (q.length > 0) {
      clauses.push("(email LIKE ? OR name LIKE ?)");
      params.push(`%${q}%`, `%${q}%`);
    }
    if (role !== undefined) {
      clauses.push("role = ?");
      params.push(role);
    }
    if (status !== undefined) {
      clauses.push("status = ?");
      params.push(status);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT id, email, name, role, status FROM users ${where} ORDER BY id LIMIT 50`,
      )
      .all(...params) as UserSummary[];
  }

  /**
   * All users whose email belongs to the given domain (suffix `@domain`, case-
   * insensitive). Powers the deterministic suspend-by-domain flow. No LIMIT —
   * the flow needs the complete set to assess risk and act on every match.
   */
  findByDomain(domain: string): UserSummary[] {
    const d = domain.trim().toLowerCase().replace(/^@+/, "");
    if (!d) return [];
    return this.db
      .prepare(
        "SELECT id, email, name, role, status FROM users WHERE lower(email) LIKE ? ORDER BY id",
      )
      .all(`%@${d}`) as UserSummary[];
  }

  getById(id: number): User {
    const user = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
      | User
      | undefined;
    if (!user) throw new UserOperationError(`No user found with id ${id}.`);
    return user;
  }

  create(actor: string, email: string, name: string, role: Role): User {
    // Email format is validated HERE, in code — not delegated to the prompt.
    if (!isValidEmail(email)) {
      throw new UserOperationError(`Invalid email format: "${email}".`);
    }
    if (!name || !name.trim()) {
      throw new UserOperationError("Name is required and cannot be empty.");
    }
    if (!isRole(role)) {
      throw new UserOperationError(
        `Invalid role: "${role}". Must be admin, editor, or viewer.`,
      );
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existing = this.db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(normalizedEmail);
    if (existing) {
      throw new UserOperationError(
        `A user with email ${normalizedEmail} already exists.`,
      );
    }

    const info = this.db
      .prepare(
        "INSERT INTO users (email, name, role, status) VALUES (?, ?, ?, ?)",
      )
      .run(normalizedEmail, name.trim(), role, "active");

    const created = this.getById(Number(info.lastInsertRowid));
    this.audit.record(actor, "create_user", created.id, {
      email: created.email,
      name: created.name,
      role: created.role,
    });
    return created;
  }

  update(actor: string, id: number, fields: UpdatableUserFields): User {
    const current = this.getById(id); // throws if missing

    const updates: string[] = [];
    const params: unknown[] = [];
    const applied: Record<string, unknown> = {};

    if (fields.email !== undefined) {
      if (!isValidEmail(fields.email)) {
        throw new UserOperationError(
          `Invalid email format: "${fields.email}".`,
        );
      }
      const normalized = fields.email.trim().toLowerCase();
      const clash = this.db
        .prepare("SELECT id FROM users WHERE email = ? AND id <> ?")
        .get(normalized, id);
      if (clash)
        throw new UserOperationError(`Email ${normalized} is already in use.`);
      updates.push("email = ?");
      params.push(normalized);
      applied.email = normalized;
    }

    if (fields.name !== undefined) {
      if (!fields.name.trim())
        throw new UserOperationError("Name cannot be empty.");
      updates.push("name = ?");
      params.push(fields.name.trim());
      applied.name = fields.name.trim();
    }

    if (fields.role !== undefined) {
      if (!isRole(fields.role)) {
        throw new UserOperationError(`Invalid role: "${fields.role}".`);
      }
      updates.push("role = ?");
      params.push(fields.role);
      applied.role = fields.role;
    }

    if (fields.status !== undefined) {
      if (!isStatus(fields.status)) {
        throw new UserOperationError(`Invalid status: "${fields.status}".`);
      }
      updates.push("status = ?");
      params.push(fields.status);
      applied.status = fields.status;
    }

    if (updates.length === 0) {
      throw new UserOperationError("No updatable fields provided.");
    }

    params.push(id);
    this.db
      .prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`)
      .run(...params);

    const updated = this.getById(id);
    this.audit.record(actor, "update_user", id, { before: current, applied });
    return updated;
  }

  suspend(actor: string, id: number, reason: string): User {
    const current = this.getById(id); // throws if missing
    if (!reason || !reason.trim()) {
      throw new UserOperationError("A reason is required to suspend a user.");
    }

    this.db
      .prepare("UPDATE users SET status = 'suspended' WHERE id = ?")
      .run(id);
    const updated = this.getById(id);
    this.audit.record(actor, "suspend_user", id, {
      reason: reason.trim(),
      previous_status: current.status,
    });
    return updated;
  }
}
