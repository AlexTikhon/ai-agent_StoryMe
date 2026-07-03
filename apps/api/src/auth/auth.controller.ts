import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { User } from '@prisma/client';
import type { UserDto } from '@book/types';
import type { Env } from '../config/env.schema';
import { toUserDto } from '../users/users.mapper';
import { AuthModeGuard } from './auth-mode.guard';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { buildRefreshCookieOptions, REFRESH_COOKIE_NAME } from './refresh-cookie';

export interface AuthResponse {
  accessToken: string;
  user: UserDto;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @UseGuards(AuthRateLimitGuard)
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const result = await this.authService.register(dto.email, dto.password, dto.name);
    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken, user: toUserDto(result.user) };
  }

  @UseGuards(AuthRateLimitGuard)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const result = await this.authService.login(dto.email, dto.password);
    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken, user: toUserDto(result.user) };
  }

  @UseGuards(AuthRateLimitGuard)
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const result = await this.authService.refresh(req.cookies?.[REFRESH_COOKIE_NAME]);
    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken, user: toUserDto(result.user) };
  }

  @UseGuards(AuthRateLimitGuard)
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.authService.logout(req.cookies?.[REFRESH_COOKIE_NAME]);
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth' });
  }

  @UseGuards(AuthModeGuard)
  @Get('me')
  getMe(@CurrentUser() user: User): UserDto {
    return toUserDto(user);
  }

  @UseGuards(AuthRateLimitGuard)
  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<{ verified: true }> {
    await this.authService.verifyEmail(dto.token);
    return { verified: true };
  }

  @UseGuards(AuthRateLimitGuard)
  @Post('resend-verification')
  @HttpCode(204)
  async resendVerification(@Body() dto: ResendVerificationDto): Promise<void> {
    await this.authService.resendVerificationEmail(dto.email);
  }

  @UseGuards(AuthRateLimitGuard)
  @Post('request-password-reset')
  @HttpCode(200)
  async requestPasswordReset(@Body() dto: RequestPasswordResetDto): Promise<{ ok: true }> {
    await this.authService.requestPasswordReset(dto.email);
    return { ok: true };
  }

  @UseGuards(AuthRateLimitGuard)
  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<{ ok: true }> {
    await this.authService.resetPassword(dto.token, dto.password);
    return { ok: true };
  }

  private setRefreshCookie(res: Response, rawRefreshToken: string): void {
    res.cookie(
      REFRESH_COOKIE_NAME,
      rawRefreshToken,
      buildRefreshCookieOptions(this.config.get('NODE_ENV', { infer: true })),
    );
  }
}
