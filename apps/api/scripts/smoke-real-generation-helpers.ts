/** Returns a clear message (never null) when preconditions aren't met, so main() can fail fast before booting Nest. */
export function checkPreconditions(env: NodeJS.ProcessEnv): string | null {
  if (!env['OPENAI_API_KEY']) {
    return 'OPENAI_API_KEY is required to run the real generation smoke test.';
  }

  const storyProvider = env['STORY_GENERATION_PROVIDER']?.trim().toLowerCase();
  const imageProvider = env['IMAGE_GENERATION_PROVIDER_TOKEN']?.trim().toLowerCase();
  if (storyProvider !== 'openai' || imageProvider !== 'openai') {
    return [
      'STORY_GENERATION_PROVIDER and IMAGE_GENERATION_PROVIDER_TOKEN must both be "openai" to run this smoke test.',
      `  STORY_GENERATION_PROVIDER=${storyProvider ?? '(unset)'}`,
      `  IMAGE_GENERATION_PROVIDER_TOKEN=${imageProvider ?? '(unset)'}`,
      'Set both to "openai" and re-run. This script never runs against mock providers — that path is already covered by the normal test suite.',
    ].join('\n');
  }

  return null;
}
