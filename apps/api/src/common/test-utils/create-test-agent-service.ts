import type { PrismaService } from '../../database/prisma.service';
import type { ImageAssetStorage } from '../../images/image-asset-storage';
import type { ImageGenerationProvider } from '../../images/image-generation-provider';
import type { PdfStorage } from '../../pdf/pdf-storage';
import { AgentService } from '../../agent/agent.service';
import type { CharacterProfileProvider } from '../../agent/character-profile-provider';
import { CharacterReferenceStage } from '../../agent/character-reference.stage';
import type { GenerationExecutionService } from '../../agent/generation-execution.service';
import { GenerationImageService } from '../../agent/generation-image.service';
import { GenerationPreparationService } from '../../agent/generation-preparation';
import { GenerationPublicationService } from '../../agent/generation-publication.service';
import { GenerationResultCollector } from '../../agent/generation-result.collector';
import { GenerationResumeService } from '../../agent/generation-resume.service';
import { ImageGenerationStage } from '../../agent/image-generation.stage';
import type { StoryGenerationProvider } from '../../agent/story-generation-provider';
import { StoryContentStage } from '../../agent/story-content.stage';
import { StoryQualityRepairStage } from '../../agent/story-quality-repair.stage';
import { StoryQualityService } from '../../agent/story-quality.service';
import type { GenerationExecutionContext } from '../../agent/generation-execution-context';

/** Explicit test composition mirroring BooksModule without opening DB/Redis. */
export function createTestAgentService(
  prisma: PrismaService,
  pdfStorage: PdfStorage,
  imageStorage: ImageAssetStorage,
  storyProvider: StoryGenerationProvider,
  imageProvider: ImageGenerationProvider,
  characterProvider: CharacterProfileProvider,
  execution: GenerationExecutionService,
): AgentService {
  // Legacy unit fixtures omit durable DB behavior; integration fixtures use the real service.
  if (!execution.authorize) execution.authorize = async () => {};
  if (!execution.assertOwnership) execution.assertOwnership = async () => {};
  if (!execution.checkpoint)
    execution.checkpoint = async (_ctx, _fingerprint, content) => {
      if (Object.keys(content).length)
        await execution.applyFencedBookWrite(
          _ctx,
          { generationCheckpoint: { content } } as never,
          'layout',
        );
    };
  if (!execution.reserveOperation) execution.reserveOperation = async () => 0;
  if (!execution.reserveHttpAttempt) execution.reserveHttpAttempt = async () => {};
  if (!execution.finishOperation) execution.finishOperation = async () => {};
  const preparation = new GenerationPreparationService(
    storyProvider,
    imageProvider,
    characterProvider,
  );
  const resume = new GenerationResumeService(imageStorage);
  const characterStage = new CharacterReferenceStage(
    imageStorage,
    characterProvider,
    imageProvider,
  );
  const collector = new GenerationResultCollector();
  const storyContentStage = new StoryContentStage(storyProvider);
  const storyRepairStage = new StoryQualityRepairStage(storyProvider);
  const imageService = new GenerationImageService(
    characterStage,
    new ImageGenerationStage(imageStorage, imageProvider),
    resume,
    collector,
  );
  const publication = new GenerationPublicationService(
    execution,
    resume,
    collector,
    imageStorage,
    pdfStorage,
  );
  return new AgentService(
    prisma,
    preparation,
    execution,
    resume,
    characterStage,
    new StoryQualityService(storyProvider, storyContentStage, storyRepairStage),
    imageService,
    publication,
    collector,
  );
}

/** Backward-shaped constructor used by the large AgentService regression suite. */
export class TestAgentService {
  private readonly delegate: AgentService;

  constructor(
    prisma: PrismaService,
    pdfStorage: PdfStorage,
    imageStorage: ImageAssetStorage,
    storyProvider: StoryGenerationProvider,
    imageProvider: ImageGenerationProvider,
    characterProvider: CharacterProfileProvider,
    execution: GenerationExecutionService,
  ) {
    this.delegate = createTestAgentService(
      prisma,
      pdfStorage,
      imageStorage,
      storyProvider,
      imageProvider,
      characterProvider,
      execution,
    );
  }

  startBookGeneration(ctx: GenerationExecutionContext) {
    return this.delegate.startBookGeneration(ctx);
  }
}
