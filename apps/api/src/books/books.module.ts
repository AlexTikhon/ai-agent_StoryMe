import { DynamicModule, Module, Provider } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CreditsModule } from '../credits/credits.module';
import { GenerationQueueProcessor } from '../agent/generation-queue.processor';
import { GenerationRunRecoveryService } from '../agent/generation-run-recovery.service';
import { ClaimArtifactCleanupService } from '../agent/claim-artifact-cleanup.service';
import { BooksController } from './books.controller';
import { BookDeletionController } from './book-deletion.controller';
import { BookHardDeletionService } from './book-hard-deletion.service';
import { BooksService } from './books.service';
import { BookCrudService } from './book-crud.service';
import { BookAssetService } from './book-asset.service';
import { BookDiagnosticsService } from './book-diagnostics.service';
import { BookGenerationService } from './book-generation.service';
import { BookGenerationExecutionService } from './book-generation-execution.service';
import { BookPageChangeService } from './book-page-change.service';
import { BookPageImageRevisionService } from './book-page-image-revision.service';
import { PageImageRevisionQueueProcessor } from '../agent/page-image-revision-queue.processor';
import { MaintenanceQueueProcessor } from '../agent/maintenance-queue.processor';
import { PageImageRevisionExecutionGateway } from './page-image-revision-execution.gateway';
import { ArtifactStorageModule } from '../storage/artifact-storage.module';
import { ProviderExecutionModule } from '../provider-execution/provider-execution.module';
import { GenerationModule } from '../agent/generation.module';

export interface BooksModuleOptions {
  /** Whether to register GenerationQueueProcessor (see app.module.ts / worker.ts). */
  enableGenerationWorker: boolean;
}

@Module({})
export class BooksModule {
  static register(options: BooksModuleOptions): DynamicModule {
    const providers: Provider[] = [
      BooksService,
      BookCrudService,
      BookAssetService,
      BookDiagnosticsService,
      BookGenerationService,
      BookGenerationExecutionService,
      BookPageChangeService,
      BookPageImageRevisionService,
      PageImageRevisionExecutionGateway,
      BookHardDeletionService,
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
      // Registered unconditionally (not gated on enableGenerationWorker) —
      // the outbox sweep is safe and useful in every process, API included,
      // since a runId-keyed BullMQ jobId makes a duplicate sweep of the same
      // event an idempotent no-op (see OutboxDispatcherService's own doc
      // comment).
    ];

    // GenerationQueueProcessor's @Processor decorator opens a real BullMQ
    // Worker (Redis connection) the moment it's instantiated — only include
    // it as a provider when this process is actually meant to consume jobs.
    if (options.enableGenerationWorker) {
      providers.push(
        GenerationQueueProcessor,
        PageImageRevisionQueueProcessor,
        MaintenanceQueueProcessor,
      );
    }

    return {
      module: BooksModule,
      imports: [
        AuthModule,
        CreditsModule,
        ArtifactStorageModule,
        ProviderExecutionModule,
        GenerationModule,
      ],
      controllers: [BooksController, BookDeletionController],
      providers,
    };
  }
}
