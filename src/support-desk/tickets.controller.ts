import { Controller, Get, Param } from "@nestjs/common";
import { TicketsService } from "./tickets.service";

@Controller("tickets")
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get(":id")
  getOne(@Param("id") id: string) {
    return this.tickets.getById(Number(id));
  }

  @Get(":id/messages")
  getThread(@Param("id") id: string) {
    return this.tickets.getThread(Number(id));
  }
}
