import { Controller, Get, Param, Query } from '@nestjs/common';
import { UsersService } from './users.service';
import { isRole, isStatus, Role, Status } from './user.types';

/** Read-only inspection endpoints (handy while poking at the seeded data). */
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  search(
    @Query('q') q?: string,
    @Query('role') role?: string,
    @Query('status') status?: string,
  ) {
    const roleFilter: Role | undefined = isRole(role) ? role : undefined;
    const statusFilter: Status | undefined = isStatus(status) ? status : undefined;
    return this.users.search(q ?? '', roleFilter, statusFilter);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.users.getById(Number(id));
  }
}
