import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import type { ChildProfileDto, ChildProfilesPageDto } from '@book/types';
import { AuthModeGuard } from '../auth/auth-mode.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import { ChildProfilesService } from './child-profiles.service';
import { CreateChildProfileDto } from './dto/create-child-profile.dto';
import { UpdateChildProfileDto } from './dto/update-child-profile.dto';

@UseGuards(AuthModeGuard, UserRateLimitGuard)
@Controller('child-profiles')
export class ChildProfilesController {
  constructor(private readonly profiles: ChildProfilesService) {}

  @Get()
  findAll(
    @CurrentUser() user: User,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ): Promise<ChildProfilesPageDto> {
    return this.profiles.findAllForUser(user.id, page, limit);
  }

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateChildProfileDto): Promise<ChildProfileDto> {
    return this.profiles.create(user.id, dto);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ChildProfileDto> {
    return this.profiles.findOneForUser(id, user.id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateChildProfileDto,
  ): Promise<ChildProfileDto> {
    return this.profiles.update(id, user.id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.profiles.remove(id, user.id);
  }
}
