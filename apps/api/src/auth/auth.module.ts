import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { DevAuthGuard } from './dev-auth.guard';

@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [DevAuthGuard],
  exports: [DevAuthGuard],
})
export class AuthModule {}
