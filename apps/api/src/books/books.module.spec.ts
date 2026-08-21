import { describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import { BooksModule } from './books.module';
import { GenerationQueueProcessor } from '../agent/generation-queue.processor';
import { BookGenerationService } from './book-generation.service';
import { BookGenerationExecutionService } from './book-generation-execution.service';
import { AgentService } from '../agent/agent.service';
import { CharacterReferenceStage } from '../agent/character-reference.stage';
import { GenerationImageService } from '../agent/generation-image.service';
import { GenerationPreparationService } from '../agent/generation-preparation';
import { GenerationPublicationService } from '../agent/generation-publication.service';
import { GenerationResultCollector } from '../agent/generation-result.collector';
import { GenerationResumeService } from '../agent/generation-resume.service';
import { ImageGenerationStage } from '../agent/image-generation.stage';
import { StoryQualityService } from '../agent/story-quality.service';
import { StoryContentStage } from '../agent/story-content.stage';
import { StoryQualityRepairStage } from '../agent/story-quality-repair.stage';
import { PrismaService } from '../database/prisma.service';
import { IMAGE_ASSET_STORAGE_TOKEN } from '../images/image-asset-storage';
import {
  IMAGE_GENERATION_PROVIDER_TOKEN,
  MockImageGenerationProvider,
} from '../images/image-generation-provider';
import { PDF_STORAGE_TOKEN } from '../pdf/pdf-storage';
import {
  MockStoryGenerationProvider,
  STORY_GENERATION_PROVIDER_TOKEN,
} from '../agent/story-generation-provider';
import {
  CHARACTER_PROFILE_PROVIDER_TOKEN,
  MockCharacterProfileProvider,
} from '../agent/character-profile-provider';
import { GenerationExecutionService } from '../agent/generation-execution.service';

/**
 * These assert on the DynamicModule metadata BooksModule.register produces,
 * not a booted Nest application — booting for real would require live
 * Postgres/Redis (DatabaseModule/QueueModule connect eagerly), which normal
 * tests must not depend on. Metadata inspection is enough to prove
 * GenerationQueueProcessor (a real BullMQ Worker the moment it's
 * instantiated) is only ever wired in when explicitly enabled.
 */
describe('BooksModule.register', () => {
  it('registers the generation scheduling boundary in both process modes', () => {
    expect(BooksModule.register({ enableGenerationWorker: false }).providers).toContain(
      BookGenerationService,
    );
    expect(BooksModule.register({ enableGenerationWorker: true }).providers).toContain(
      BookGenerationService,
    );
    expect(BooksModule.register({ enableGenerationWorker: false }).providers).toContain(
      BookGenerationExecutionService,
    );
    expect(BooksModule.register({ enableGenerationWorker: true }).providers).toContain(
      BookGenerationExecutionService,
    );
  });

  it('does not register the removed legacy GenerationJob mirror services', () => {
    const providerNames = (BooksModule.register({ enableGenerationWorker: true }).providers ?? [])
      .map((provider) => (typeof provider === 'function' ? provider.name : null))
      .filter((name): name is string => name !== null);

    expect(providerNames).not.toContain('GenerationJobService');
    expect(providerNames).not.toContain('GenerationJobRecoveryService');
  });

  it('omits GenerationQueueProcessor when enableGenerationWorker is false (API mode)', () => {
    const dynamicModule = BooksModule.register({ enableGenerationWorker: false });

    expect(dynamicModule.providers).not.toContain(GenerationQueueProcessor);
  });

  it('includes GenerationQueueProcessor when enableGenerationWorker is true (worker mode)', () => {
    const dynamicModule = BooksModule.register({ enableGenerationWorker: true });

    expect(dynamicModule.providers).toContain(GenerationQueueProcessor);
  });

  it('registers every AgentService collaborator in worker composition', () => {
    const providers = BooksModule.register({ enableGenerationWorker: true }).providers;
    for (const provider of [
      AgentService,
      GenerationPreparationService,
      GenerationResumeService,
      CharacterReferenceStage,
      StoryContentStage,
      StoryQualityRepairStage,
      StoryQualityService,
      ImageGenerationStage,
      GenerationResultCollector,
      GenerationImageService,
      GenerationPublicationService,
    ]) {
      expect(providers).toContain(provider);
    }
  });

  it('resolves AgentService through the same Nest provider graph used by the worker', async () => {
    const module = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: {} },
        { provide: IMAGE_ASSET_STORAGE_TOKEN, useValue: {} },
        { provide: PDF_STORAGE_TOKEN, useValue: {} },
        { provide: STORY_GENERATION_PROVIDER_TOKEN, useValue: new MockStoryGenerationProvider() },
        {
          provide: CHARACTER_PROFILE_PROVIDER_TOKEN,
          useValue: new MockCharacterProfileProvider(),
        },
        {
          provide: IMAGE_GENERATION_PROVIDER_TOKEN,
          useValue: new MockImageGenerationProvider(),
        },
        GenerationExecutionService,
        GenerationPreparationService,
        GenerationResumeService,
        CharacterReferenceStage,
        StoryContentStage,
        StoryQualityRepairStage,
        StoryQualityService,
        ImageGenerationStage,
        GenerationResultCollector,
        GenerationImageService,
        GenerationPublicationService,
        AgentService,
      ],
    }).compile();

    expect(module.get(AgentService)).toBeInstanceOf(AgentService);
    await module.close();
  });
});
