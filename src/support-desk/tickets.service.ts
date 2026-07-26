import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { MessageSender, Ticket, TicketMessage, TicketStatus } from "./support-desk.types";
import { detectLegalOrSecurityKeywords } from "./legal-keyword-filter";

export class TicketOperationError extends Error {}

export interface LegalSecurityCheck {
  flagged: boolean;
  matched_keywords: string[];
}

@Injectable()
export class TicketsService {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  getById(id: number): Ticket {
    const ticket = this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as
      | Ticket
      | undefined;
    if (!ticket) throw new TicketOperationError(`No ticket found with id ${id}.`);
    return ticket;
  }

  getThread(ticketId: number): TicketMessage[] {
    return this.db
      .prepare("SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id")
      .all(ticketId) as TicketMessage[];
  }

  addMessage(ticketId: number, sender: MessageSender, body: string): TicketMessage {
    this.getById(ticketId); // throws if missing
    const info = this.db
      .prepare("INSERT INTO ticket_messages (ticket_id, sender, body) VALUES (?, ?, ?)")
      .run(ticketId, sender, body);
    return this.db
      .prepare("SELECT * FROM ticket_messages WHERE id = ?")
      .get(Number(info.lastInsertRowid)) as TicketMessage;
  }

  updateStatus(ticketId: number, status: TicketStatus): Ticket {
    this.getById(ticketId); // throws if missing
    this.db.prepare("UPDATE tickets SET status = ? WHERE id = ?").run(status, ticketId);
    return this.getById(ticketId);
  }

  /**
   * The independent legal/security guardrail, run against the ticket's
   * subject/body plus its full message thread. This is the single call site
   * both Mode A's get_ticket tool and the deterministic flows use, so the
   * guardrail has exactly one implementation.
   */
  checkLegalOrSecurityFlags(ticketId: number): LegalSecurityCheck {
    const ticket = this.getById(ticketId);
    const thread = this.getThread(ticketId);
    const text = [ticket.subject, ticket.body, ...thread.map((m) => m.body)].join("\n");
    const matched_keywords = detectLegalOrSecurityKeywords(text);
    return { flagged: matched_keywords.length > 0, matched_keywords };
  }
}
