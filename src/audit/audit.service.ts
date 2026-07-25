import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuditLogEntry } from '../users/user.types';

@Injectable()
export class AuditService {
  constructor(private readonly database: DatabaseService) {}

  record(
    actor: string,
    action: string,
    targetUserId: number | null,
    details: Record<string, unknown> = {},
  ): void {
    this.database.db
      .prepare(
        `INSERT INTO audit_log (actor, action, target_user_id, details)
         VALUES (?, ?, ?, ?)`,
      )
      .run(actor, action, targetUserId, JSON.stringify(details));
  }

  list(limit = 100): AuditLogEntry[] {
    return this.database.db
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(limit) as AuditLogEntry[];
  }
}
