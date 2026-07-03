import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { DevAuthGuard } from './dev-auth.guard';

@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [DevAuthGuard],
  // Re-export UsersModule alongside DevAuthGuard: modules that only import
  // AuthModule to use @UseGuards(DevAuthGuard) (e.g. BooksModule) otherwise
  // fail to resolve the guard's own UsersService dependency, since Nest
  // resolves a cross-module guard's constructor deps relative to the
  // *consuming* module's visible providers, not just the guard's own module.
  exports: [DevAuthGuard, UsersModule],
})
export class AuthModule {}
