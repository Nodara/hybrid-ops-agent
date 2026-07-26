export const PLANS = ['starter', 'pro', 'enterprise'] as const;
export type Plan = (typeof PLANS)[number];

export const SUBSCRIPTION_STATUSES = ['active', 'canceled', 'past_due'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export interface Subscription {
  id: number;
  user_id: number;
  plan: Plan;
  mrr_cents: number;
  status: SubscriptionStatus;
  renewed_at: string;
}

export const TICKET_STATUSES = ['open', 'resolved', 'escalated'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export interface Ticket {
  id: number;
  user_id: number;
  subject: string;
  body: string;
  status: TicketStatus;
  created_at: string;
}

export const MESSAGE_SENDERS = ['customer', 'agent', 'human'] as const;
export type MessageSender = (typeof MESSAGE_SENDERS)[number];

export interface TicketMessage {
  id: number;
  ticket_id: number;
  sender: MessageSender;
  body: string;
  created_at: string;
}

export interface Refund {
  id: number;
  subscription_id: number;
  amount_cents: number;
  reason: string;
  issued_by: string;
  approved_by: string | null;
  created_at: string;
}

export interface KbArticle {
  id: number;
  title: string;
  body: string;
  keywords: string;
}

export function isPlan(value: unknown): value is Plan {
  return typeof value === 'string' && (PLANS as readonly string[]).includes(value);
}

export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return (
    typeof value === 'string' &&
    (SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
  );
}

export function isTicketStatus(value: unknown): value is TicketStatus {
  return typeof value === 'string' && (TICKET_STATUSES as readonly string[]).includes(value);
}

export function isMessageSender(value: unknown): value is MessageSender {
  return typeof value === 'string' && (MESSAGE_SENDERS as readonly string[]).includes(value);
}
