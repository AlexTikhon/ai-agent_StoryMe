import { DynamicModule, Module, Provider } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CreditsModule } from '../credits/credits.module';
import { AgentService } from '../agent/agent.service';
import { GenerationQueueService } from '../agent/generation-queue.service';
import { GenerationQueueProcessor } from '../agent/generation-queue.processor';
import { GenerationJobService } from '../agent/generation-job.service';
import { GenerationJobRecoveryService } from '../agent/generation-job-recovery.service';
import { GenerationRunService } from '../agent/generation-run.service';
import { GenerationRunRecoveryService } from '../agent/generation-run-recovery.service';
import { ClaimArtifactCleanupService } from '../agent/claim-artifact-cleanup.service';
import { GenerationExecutionService } from '../agent/generation-execution.service';
import { GenerationRunCoordinator } from '../agent/generation-run-coordinator.service';
import { GenerationInputSnapshotBackfillService } from '../agent/generation-input-snapshot-backfill.service';
import { OutboxService } from '../outbox/outbox.service';
import { OutboxDispatcherService } from '../outbox/outbox-dispatcher.service';
import { BooksController } from './books.controller';
import { BooksService } from './books.service';
import { BookCrudService } from './book-crud.service';
import { BookAssetService } from './book-asset.service';
import { createPdfStorage, PDF_STORAGE_TOKEN } from '../pdf/pdf-storage';
import { IMAGE_ASSET_STORAGE_TOKEN, createImageAssetStorage } from '../images/image-asset-storage';
import { ChildPhotoProcessor } from '../images/child-photo-processor';
import { IMAGE_GENERATION_PROVIDER_TOKEN } from '../images/image-generation-provider';
import { createImageGenerationProvider } from '../images/image-generation-provider.factory';
import { STORY_GENERATION_PROVIDER_TOKEN } from '../agent/story-generation-provider';
import { createStoryGenerationProvider } from '../agent/story-generation-provider.factory';
import { CHARACTER_PROFILE_PROVIDER_TOKEN } from '../agent/character-profile-provider';
import { createCharacterProfileProvider } from '../agent/character-profile-provider.factory';

export interface BooksModuleOptions {
  /** Whether to register GenerationQueueProcessor (see app.module.ts / worker.ts). */
  enableGenerationWorker: boolean;
}

@Module({})
export class BooksModule {
  static register(options: BooksModuleOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: PDF_STORAGE_TOKEN,
        useFactory: () => createPdfStorage(process.env['PDF_STORAGE_DRIVER']),
      },
      {
        provide: IMAGE_ASSET_STORAGE_TOKEN,
        useFactory: () => createImageAssetStorage(process.env['IMAGE_STORAGE_DRIVER']),
      },
      {
        provide: STORY_GENERATION_PROVIDER_TOKEN,
        useFactory: () => createStoryGenerationProvider(),
      },
      {
        provide: CHARACTER_PROFILE_PROVIDER_TOKEN,
        useFactory: () => createCharacterProfileProvider(),
      },
      {
        provide: IMAGE_GENERATION_PROVIDER_TOKEN,
        useFactory: () => createImageGenerationProvider(),
      },
      BooksService,
      BookCrudService,
      BookAssetService,
      AgentService,
      GenerationQueueService,
      GenerationJobService,
      GenerationJobRecoveryService,
      GenerationRunService,
      GenerationExecutionService,
      GenerationRunCoordinator,
      GenerationInputSnapshotBackfillService,
      // Registered unconditionally, same reasoning as OutboxDispatcherService
      // below — recovery is safe and useful in every process, and its
      // Postgres advisory lock already ensures only one live instance runs a
      // pass at a time.
      GenerationRunRecoveryService,
      // Registered unconditionally, same reasoning as GenerationRunRecoveryService
      // above — the sweep is a no-op unless CLAIM_CLEANUP_ENABLED=true, and its
      // own dedicated RecoveryLease row ensures only one live instance runs a
      // pass at a time even with both API and worker registering it.
      ClaimArtifactCleanupService,
      OutboxService,
      // Registered unconditionally (not gated on enableGenerationWorker) —
      // the outbox sweep is safe and useful in every process, API included,
      // since a runId-keyed BullMQ jobId makes a duplicate sweep of the same
      // event an idempotent no-op (see OutboxDispatcherService's own doc
      // comment).
      OutboxDispatcherService,
      ChildPhotoProcessor,
    ];

    // GenerationQueueProcessor's @Processor decorator opens a real BullMQ
    // Worker (Redis connection) the moment it's instantiated — only include
    // it as a provider when this process is actually meant to consume jobs.
    if (options.enableGenerationWorker) {
      providers.push(GenerationQueueProcessor);
    }

    return {
      module: BooksModule,
      imports: [AuthModule, CreditsModule],
      controllers: [BooksController],
      providers,
    };
  }
}
