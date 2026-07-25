import { Module } from '@nestjs/common';
import { AgentService } from './agent.service';
import { TurnLogger } from './turn-logger.service';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  providers: [AgentService, TurnLogger],
  exports: [AgentService],
})
export class AgentModule {}
