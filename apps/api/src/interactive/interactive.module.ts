import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InteractiveController } from './interactive.controller';
import { InteractiveScenariosController } from './interactive-scenarios.controller';
import { InteractiveService, SCENARIO_REGISTRY } from './interactive.service';
import { MockNarratorProvider } from './narrator/mock-narrator.provider';
import { NARRATOR_PROVIDER } from './narrator/narrator';
import { publishedScenarioRegistry } from './scenarios';

/** Interactive story engine. Independent of the book generation pipeline. */
@Module({
  imports: [AuthModule],
  controllers: [InteractiveController, InteractiveScenariosController],
  providers: [
    InteractiveService,
    { provide: NARRATOR_PROVIDER, useClass: MockNarratorProvider },
    { provide: SCENARIO_REGISTRY, useValue: publishedScenarioRegistry },
  ],
  exports: [InteractiveService],
})
export class InteractiveModule {}
