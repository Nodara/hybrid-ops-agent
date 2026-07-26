import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { SuspendByDomainFlow } from "./flows/suspend-by-domain.flow";
import {
  BulkOnboardRow,
  BulkOnboardUsersFlow,
} from "./flows/bulk-onboard-users.flow";

interface SuspendDomainRequest {
  domain: string;
  actor?: string;
}

interface BulkOnboardRequest {
  rows: BulkOnboardRow[];
  actor?: string;
}

/**
 * Direct entry points for the deterministic flows, bypassing the classifier.
 * Real systems let you call a known workflow directly when you already know
 * what you want, and reserve the agent/router path (`POST /orchestrate`) for
 * natural-language entry — the flow handlers are pure enough to be called
 * from either path.
 */
@Controller("flows")
export class FlowsController {
  constructor(
    private readonly suspendByDomain: SuspendByDomainFlow,
    private readonly bulkOnboardFlow: BulkOnboardUsersFlow,
  ) {}

  @Post("suspend-domain")
  @HttpCode(200)
  suspendDomain(@Body() body: SuspendDomainRequest) {
    const domain = (body?.domain ?? "").trim();
    if (!domain) {
      return { error: 'A non-empty "domain" is required.' };
    }
    const actor = (body?.actor ?? "ops-console").trim() || "ops-console";
    return this.suspendByDomain.execute(domain, actor);
  }

  @Post("bulk-onboard")
  @HttpCode(200)
  bulkOnboard(@Body() body: BulkOnboardRequest) {
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (rows.length === 0) {
      return { error: 'A non-empty "rows" array is required.' };
    }
    const actor = (body?.actor ?? "ops-console").trim() || "ops-console";
    return this.bulkOnboardFlow.execute(rows, actor);
  }
}
