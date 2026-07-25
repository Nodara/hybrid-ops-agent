export const ROLES = ['admin', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const STATUSES = ['active', 'suspended', 'deleted'] as const;
export type Status = (typeof STATUSES)[number];

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  status: Status;
  created_at: string;
}

/** Trimmed shape returned by search_users — cheap for the model to scan. */
export interface UserSummary {
  id: number;
  email: string;
  name: string;
  role: Role;
  status: Status;
}

export interface AuditLogEntry {
  id: number;
  actor: string;
  action: string;
  target_user_id: number | null;
  timestamp: string;
  details: string | null;
}

/** Fields update_user is allowed to change (partial). */
export interface UpdatableUserFields {
  email?: string;
  name?: string;
  role?: Role;
  status?: Status;
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

// Deliberately validated in code (not the prompt): a pragmatic RFC-5322-ish check.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && EMAIL_RE.test(value.trim());
}
