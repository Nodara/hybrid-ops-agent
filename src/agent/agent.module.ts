import { Module } from '@nestjs/common';
import { AgentService } from './agent.service';
import { TurnLogger } from './turn-logger.service';
import { UsersModule } from '../users/users.module';
import { SupportDeskModule } from '../support-desk/support-desk.module';

@Module({
  imports: [UsersModule, SupportDeskModule],
  providers: [AgentService, TurnLogger],
  exports: [AgentService],
})
export class AgentModule {}
