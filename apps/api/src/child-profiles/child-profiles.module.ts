import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChildProfilesController } from './child-profiles.controller';
import { ChildProfilesService } from './child-profiles.service';

@Module({
  imports: [AuthModule],
  controllers: [ChildProfilesController],
  providers: [ChildProfilesService],
  exports: [ChildProfilesService],
})
export class ChildProfilesModule {}
