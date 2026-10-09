import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InteractiveController } from './interactive.controller';
import { InteractiveService } from './interactive.service';
import { MockNarratorProvider } from './narrator/mock-narrator.provider';
import { NARRATOR_PROVIDER } from './narrator/narrator';

/** Interactive story engine. Independent of the book generation pipeline. */
@Module({
  imports: [AuthModule],
  controllers: [InteractiveController],
  providers: [InteractiveService, { provide: NARRATOR_PROVIDER, useClass: MockNarratorProvider }],
  exports: [InteractiveService],
})
export class InteractiveModule {}
