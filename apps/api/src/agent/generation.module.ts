import { Module } from '@nestjs/common';
import { CreditsModule } from '../credits/credits.module';
import { OutboxDispatcherService } from '../outbox/outbox-dispatcher.service';
import { OutboxService } from '../outbox/outbox.service';
import { ProviderExecutionModule } from '../provider-execution/provider-execution.module';
import { ArtifactStorageModule } from '../storage/artifact-storage.module';
import { AgentService } from './agent.service';
import { CharacterReferenceStage } from './character-reference.stage';
import { GenerationExecutionService } from './generation-execution.service';
import { GenerationImageService } from './generation-image.service';
import { GenerationInputSnapshotBackfillService } from './generation-input-snapshot-backfill.service';
import { GenerationPreparationService } from './generation-preparation';
import { GenerationPublicationService } from './generation-publication.service';
import { GenerationQueueService } from './generation-queue.service';
import { GenerationResultCollector } from './generation-result.collector';
import { GenerationResumeService } from './generation-resume.service';
import { GenerationRunCoordinator } from './generation-run-coordinator.service';
import { GenerationRunService } from './generation-run.service';
import { ImageGenerationStage } from './image-generation.stage';
import { StoryContentStage } from './story-content.stage';
import { StoryQualityRepairStage } from './story-quality-repair.stage';
import { StoryQualityService } from './story-quality.service';

const GENERATION_EXPORTS = [
  AgentService,
  GenerationResumeService,
  GenerationQueueService,
  GenerationRunService,
  GenerationExecutionService,
  GenerationRunCoordinator,
  GenerationInputSnapshotBackfillService,
] as const;

/** Application-level generation composition. Durable outbox dispatch belongs
 * here; HTTP book CRUD does not construct providers or artifact drivers. */
@Module({
  imports: [CreditsModule, ArtifactStorageModule, ProviderExecutionModule],
  providers: [
    GenerationPreparationService,
    CharacterReferenceStage,
    StoryContentStage,
    StoryQualityRepairStage,
    StoryQualityService,
    ImageGenerationStage,
    GenerationResultCollector,
    GenerationImageService,
    GenerationPublicationService,
    ...GENERATION_EXPORTS,
    OutboxService,
    OutboxDispatcherService,
  ],
  exports: [...GENERATION_EXPORTS],
})
export class GenerationModule {}
