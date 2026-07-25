import { Controller, Get, Query } from '@nestjs/common';
import { AuditService } from './audit.service';

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query('limit') limit?: string) {
    const n = limit ? Math.max(1, Math.min(500, Number(limit) || 100)) : 100;
    return this.audit.list(n);
  }
}
