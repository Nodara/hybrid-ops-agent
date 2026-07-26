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

type MutatingAction = "create_user" | "update_user" | "suspend_user";

/**
 * Which roles may perform each mutating action. Enforced here, in the tool
 * implementation, rather than left to the model/prompt — a viewer-level actor
 * must never be able to invoke suspend_user even if an agent "decides" to.
 * suspend_user is admin-only since it's the highest blast-radius action.
 */
const ACTION_PERMISSIONS: Record<MutatingAction, Role[]> = {
  create_user: ["editor", "admin"],
  update_user: ["editor", "admin"],
  suspend_user: ["admin"],
};

@Injectable()
export class UsersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Runs `fn` inside a single SQLite transaction. Used to make each mutation's
   * row change and its audit_log write atomic — if the audit insert throws,
   * the mutation is rolled back with it.
   */
  private inTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Runs several mutations (e.g. multiple `create` calls from a bulk-onboard
   * flow) as one atomic unit — all commit together or none do. Exposed so
   * callers can compose multiple UsersService calls atomically without
   * reaching into the DB layer themselves.
   */
  runAtomically<T>(fn: () => T): T {
    return this.inTransaction(fn);
  }

  /**
   * Resolves an actor string to a role. An actor that matches a known user's
   * email gets that user's actual role, so a real viewer/editor account stays
   * restricted. An actor that doesn't resolve to any user (e.g. the
   * "ops-console" system label used when no operator identity is passed) is
   * treated as a trusted internal caller and gets admin.
   *
   * Public so other domains (e.g. SupportDesk's RefundsService) can reuse the
   * same actor-role lookup instead of duplicating the SQL query.
   */
  resolveActorRole(actor: string): Role {
    const normalized = (actor ?? "").trim().toLowerCase();
    const row = this.db
      .prepare("SELECT role FROM users WHERE email = ?")
      .get(normalized) as { role: Role } | undefined;
    return row?.role ?? "admin";
  }

  /** Throws if `actor` is not permitted to perform `action`. */
  private authorize(actor: string, action: MutatingAction): void {
    const role = this.resolveActorRole(actor);
    if (!ACTION_PERMISSIONS[action].includes(role)) {
      throw new UserOperationError(
        `Actor "${actor}" (role: ${role}) is not authorized to perform "${action}".`,
      );
    }
  }

  search(
    query: string,
    role?: Role,
    status?: Status,
    country?: string,
    city?: string,
  ): UserSummary[] {
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
    if (country !== undefined && country.trim().length > 0) {
      clauses.push("lower(country) = lower(?)");
      params.push(country.trim());
    }
    if (city !== undefined && city.trim().length > 0) {
      clauses.push("lower(city) = lower(?)");
      params.push(city.trim());
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT id, email, name, role, status, country, city FROM users ${where} ORDER BY id LIMIT 50`,
      )
      .all(...params) as UserSummary[];
  }

  /** Whether a user with this (normalized) email already exists. */
  emailExists(email: string): boolean {
    const normalized = email.trim().toLowerCase();
    return (
      this.db.prepare("SELECT id FROM users WHERE email = ?").get(normalized) !==
      undefined
    );
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
        "SELECT id, email, name, role, status, country, city FROM users WHERE lower(email) LIKE ? ORDER BY id",
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
    this.authorize(actor, "create_user");

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

    return this.inTransaction(() => {
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
    });
  }

  update(actor: string, id: number, fields: UpdatableUserFields): User {
    this.authorize(actor, "update_user");
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
    return this.inTransaction(() => {
      this.db
        .prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`)
        .run(...params);

      const updated = this.getById(id);
      this.audit.record(actor, "update_user", id, {
        before: current,
        applied,
      });
      return updated;
    });
  }

  suspend(actor: string, id: number, reason: string): User {
    this.authorize(actor, "suspend_user");
    const current = this.getById(id); // throws if missing
    if (!reason || !reason.trim()) {
      throw new UserOperationError("A reason is required to suspend a user.");
    }

    return this.inTransaction(() => {
      // Idempotent: suspending an already-suspended user is a no-op on the
      // row, but the attempt is still audited (retries/double-clicks/agent
      // retries after a transient failure shouldn't error or double-write).
      if (current.status !== "suspended") {
        this.db
          .prepare("UPDATE users SET status = 'suspended' WHERE id = ?")
          .run(id);
      }

      const updated = this.getById(id);
      this.audit.record(actor, "suspend_user", id, {
        reason: reason.trim(),
        previous_status: current.status,
        idempotent_noop: current.status === "suspended",
      });
      return updated;
    });
  }
}
