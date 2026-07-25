import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { UsersModule } from './users/users.module';
import { AuditModule } from './audit/audit.module';
import { AgentModule } from './agent/agent.module';
import { OrchestratorModule } from './orchestrator/orchestrator.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    DatabaseModule,
    UsersModule,
    AuditModule,
    AgentModule,
    OrchestratorModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
