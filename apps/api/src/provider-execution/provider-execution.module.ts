import { Module } from '@nestjs/common';
import { CHARACTER_PROFILE_PROVIDER_TOKEN } from '../agent/character-profile-provider';
import { createCharacterProfileProvider } from '../agent/character-profile-provider.factory';
import { STORY_GENERATION_PROVIDER_TOKEN } from '../agent/story-generation-provider';
import { createStoryGenerationProvider } from '../agent/story-generation-provider.factory';
import { IMAGE_GENERATION_PROVIDER_TOKEN } from '../images/image-generation-provider';
import { createImageGenerationProvider } from '../images/image-generation-provider.factory';
import { RedisProviderQuotaGate } from '../images/provider-quota-gate';

/** Owns provider selection plus shared distributed quota control. It exports
 * provider-neutral injection tokens, never concrete OpenAI implementations. */
@Module({
  providers: [
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
      inject: [RedisProviderQuotaGate],
      useFactory: (quotaGate: RedisProviderQuotaGate) =>
        createImageGenerationProvider(process.env, quotaGate),
    },
    RedisProviderQuotaGate,
  ],
  exports: [
    STORY_GENERATION_PROVIDER_TOKEN,
    CHARACTER_PROFILE_PROVIDER_TOKEN,
    IMAGE_GENERATION_PROVIDER_TOKEN,
    RedisProviderQuotaGate,
  ],
})
export class ProviderExecutionModule {}
