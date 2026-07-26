import { Controller, Get, Param, Query } from "@nestjs/common";
import { SubscriptionsService } from "./subscriptions.service";

@Controller("subscriptions")
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get()
  getByUser(@Query("user_id") userId: string) {
    return this.subscriptions.getByUserId(Number(userId));
  }

  @Get(":id")
  getOne(@Param("id") id: string) {
    return this.subscriptions.getById(Number(id));
  }
}
