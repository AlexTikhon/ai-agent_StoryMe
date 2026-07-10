import { DynamicModule, Module, Provider } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AgentService } from '../agent/agent.service';
import { GenerationQueueService } from '../agent/generation-queue.service';
import { GenerationQueueProcessor } from '../agent/generation-queue.processor';
import { GenerationJobService } from '../agent/generation-job.service';
import { GenerationJobRecoveryService } from '../agent/generation-job-recovery.service';
import { BooksController } from './books.controller';
import { BooksService } from './books.service';
import { createPdfStorage, PDF_STORAGE_TOKEN } from '../pdf/pdf-storage';
import { IMAGE_ASSET_STORAGE_TOKEN, createImageAssetStorage } from '../images/image-asset-storage';
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
      AgentService,
      GenerationQueueService,
      GenerationJobService,
      GenerationJobRecoveryService,
    ];

    // GenerationQueueProcessor's @Processor decorator opens a real BullMQ
    // Worker (Redis connection) the moment it's instantiated — only include
    // it as a provider when this process is actually meant to consume jobs.
    if (options.enableGenerationWorker) {
      providers.push(GenerationQueueProcessor);
    }

    return {
      module: BooksModule,
      imports: [AuthModule],
      controllers: [BooksController],
      providers,
    };
  }
}
