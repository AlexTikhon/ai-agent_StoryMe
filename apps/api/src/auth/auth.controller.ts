import { Controller, Get, UseGuards } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { UserDto } from '@book/types';
import { CurrentUser } from './current-user.decorator';
import { DevAuthGuard } from './dev-auth.guard';
import { toUserDto } from '../users/users.mapper';

@UseGuards(DevAuthGuard)
@Controller()
export class AuthController {
  @Get('me')
  getMe(@CurrentUser() user: User): UserDto {
    return toUserDto(user);
  }
}
