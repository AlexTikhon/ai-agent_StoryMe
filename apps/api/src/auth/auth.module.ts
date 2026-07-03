import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { Env } from '../config/env.schema';
import { EmailModule } from '../email/email.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthModeGuard } from './auth-mode.guard';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import { AuthService } from './auth.service';
import { DevAuthGuard } from './dev-auth.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokenService } from './token.service';

@Module({
  imports: [
    UsersModule,
    EmailModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    DevAuthGuard,
    JwtAuthGuard,
    AuthModeGuard,
    AuthRateLimitGuard,
  ],
  // Re-export UsersModule alongside the guards: modules that only import
  // AuthModule to use @UseGuards(AuthModeGuard) (e.g. BooksModule) otherwise
  // fail to resolve DevAuthGuard's/JwtAuthGuard's own UsersService
  // dependency, since Nest resolves a cross-module guard's constructor deps
  // relative to the *consuming* module's visible providers, not just the
  // guard's own module. (Same boot-blocking bug class fixed in Phase 5C —
  // see docs/deployment-readiness.md.)
  exports: [DevAuthGuard, JwtAuthGuard, AuthModeGuard, UsersModule],
})
export class AuthModule {}
