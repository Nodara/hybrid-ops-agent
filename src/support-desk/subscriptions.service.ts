import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { Subscription } from "./support-desk.types";

export class SubscriptionOperationError extends Error {}

@Injectable()
export class SubscriptionsService {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  getById(id: number): Subscription {
    const subscription = this.db
      .prepare("SELECT * FROM subscriptions WHERE id = ?")
      .get(id) as Subscription | undefined;
    if (!subscription) {
      throw new SubscriptionOperationError(`No subscription found with id ${id}.`);
    }
    return subscription;
  }

  getByUserId(userId: number): Subscription {
    const subscription = this.db
      .prepare("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1")
      .get(userId) as Subscription | undefined;
    if (!subscription) {
      throw new SubscriptionOperationError(`No subscription found for user ${userId}.`);
    }
    return subscription;
  }
}
