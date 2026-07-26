import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { UsersModule } from "../users/users.module";
import { TicketsService } from "./tickets.service";
import { SubscriptionsService } from "./subscriptions.service";
import { RefundsService } from "./refunds.service";
import { KbService } from "./kb.service";
import { TicketsController } from "./tickets.controller";
import { SubscriptionsController } from "./subscriptions.controller";

@Module({
  imports: [AuditModule, UsersModule],
  providers: [TicketsService, SubscriptionsService, RefundsService, KbService],
  controllers: [TicketsController, SubscriptionsController],
  exports: [TicketsService, SubscriptionsService, RefundsService, KbService],
})
export class SupportDeskModule {}
