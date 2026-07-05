import { Module } from '@nestjs/common';
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

@Module({
  imports: [AuthModule],
  controllers: [BooksController],
  providers: [
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
      provide: IMAGE_GENERATION_PROVIDER_TOKEN,
      useFactory: () => createImageGenerationProvider(),
    },
    BooksService,
    AgentService,
    GenerationQueueService,
    GenerationQueueProcessor,
    GenerationJobService,
    GenerationJobRecoveryService,
  ],
})
export class BooksModule {}
