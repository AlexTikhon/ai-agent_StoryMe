import { readFile, writeFile } from 'node:fs/promises';
import type { ProviderCallMetrics, StoryQualityDimensions } from '@book/types';
import { finalizeCharacterProfile } from '../src/agent/character-appearance';
import {
  MockStoryGenerationProvider,
  type StoryGenerationInput,
  type StoryGenerationProvider,
  type StoryGenerationResult,
} from '../src/agent/story-generation-provider';
import { OpenAIStoryGenerationProvider } from '../src/agent/openai-story-generation-provider';
import {
  evaluateStoryQuality,
  storyGenerationInputToQualityInput,
} from '../src/agent/story-quality-gate';
import { validateStoryGenerationResult } from '../src/agent/story-generation-result-validator';
import {
  assertPaidProviderCallBudget,
  hashProviderPrompt,
  resolveMaxPaidProviderCallsPerRun,
} from '../src/agent/generation-provider-telemetry';

export interface StoryEvalCase {
  caseId: string;
  language: 'en' | 'pl' | 'ru';
  age: 4 | 6 | 8;
  themeCategory: 'everyday' | 'adventure' | 'space' | 'animals' | 'friendship';
  theme: string;
  educationalMessage?: string;
  pageCount: number;
}

export interface StoryEvalCaseResult {
  caseId: string;
  language: string;
  age: number;
  themeCategory: string;
  requestedPageCount: number;
  actualPageCount: number;
  provider: string;
  model?: string;
  promptVersion: string;
  promptHash: string;
  passed: boolean;
  structuralValid: boolean;
  pageCountValid: boolean;
  qualityPassed: boolean;
  qualityDimensions: StoryQualityDimensions;
  characterConsistencyPassed: boolean;
  issueCodes: string[];
  repairRequired: boolean;
  repairAttempted: boolean;
  durationMs: number;
  logicalProviderCalls: number;
  httpAttempts: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
}

export const STORY_EVAL_CASES: readonly StoryEvalCase[] = [
  {
    caseId: 'en-age4-everyday',
    language: 'en',
    age: 4,
    themeCategory: 'everyday',
    theme: 'a realistic day at the park',
    pageCount: 4,
  },
  {
    caseId: 'pl-age6-friendship',
    language: 'pl',
    age: 6,
    themeCategory: 'friendship',
    theme: 'friendship',
    educationalMessage: 'kindness',
    pageCount: 6,
  },
  {
    caseId: 'ru-age8-space',
    language: 'ru',
    age: 8,
    themeCategory: 'space',
    theme: 'space exploration',
    educationalMessage: 'confidence',
    pageCount: 8,
  },
  {
    caseId: 'en-age6-animals',
    language: 'en',
    age: 6,
    themeCategory: 'animals',
    theme: 'animals in a forest',
    educationalMessage: 'patience',
    pageCount: 6,
  },
  {
    caseId: 'pl-age8-adventure',
    language: 'pl',
    age: 8,
    themeCategory: 'adventure',
    theme: 'mountain adventure',
    pageCount: 4,
  },
  {
    caseId: 'ru-age4-friendship',
    language: 'ru',
    age: 4,
    themeCategory: 'friendship',
    theme: 'friendship',
    educationalMessage: 'kindness',
    pageCount: 4,
  },
] as const;

function syntheticInput(testCase: StoryEvalCase): StoryGenerationInput {
  const childName = 'Nova';
  const characterProfile = finalizeCharacterProfile(
    {
      childName,
      age: testCase.age,
      visualDescription: 'Nova is a cheerful synthetic story character',
      faceDescription: 'a heart-shaped face with a small dimple',
      hairDescription: 'straight light-blonde hair in a low ponytail',
      outfitDescription: 'a cobalt-blue jacket with silver buttons',
      personalitySummary: 'patient, kind, and confident',
      illustrationStyle: 'layered paper-cut storybook illustration',
      consistencyPrompt: '',
      hasReferencePhoto: false,
      hasCharacterSheet: false,
    },
    { eyeDescription: 'large expressive green eyes' },
  );
  return {
    bookId: `eval-${testCase.caseId}`,
    childName,
    childAge: testCase.age,
    theme: testCase.theme,
    language: testCase.language,
    pageCount: testCase.pageCount,
    ...(testCase.educationalMessage && {
      educationalMessage: testCase.educationalMessage,
    }),
    characterProfile,
  };
}

function characterConsistencyPassed(
  story: StoryGenerationResult,
  input: StoryGenerationInput,
): boolean {
  const locked = input.characterProfile.lockedVisualDescription;
  if (!locked || story.characterCard.visualAnchor !== locked || story.characterCard.appearance) {
    return false;
  }
  return story.imageGenerationResult.images.every(
    (image) =>
      image.prompt.split(locked).length - 1 === 1 &&
      !/wavy brown hair|medium skin tone|"skinTone":"medium"/iu.test(image.prompt),
  );
}

export async function evaluateStoryCases(
  provider: StoryGenerationProvider,
  cases: readonly StoryEvalCase[],
  estimatedCostPerCallUsd?: number,
): Promise<StoryEvalCaseResult[]> {
  const results: StoryEvalCaseResult[] = [];
  for (const testCase of cases) {
    const startedAt = Date.now();
    const input = syntheticInput(testCase);
    const promptVersion = provider.promptVersion ?? 'legacy-story-v1';
    const promptHash = hashProviderPrompt(promptVersion, input);
    const metrics: Required<Pick<ProviderCallMetrics, 'httpAttempts'>> &
      Pick<ProviderCallMetrics, 'inputTokens' | 'outputTokens'> = { httpAttempts: 0 };
    const onMetrics = (reported: ProviderCallMetrics) => {
      metrics.httpAttempts += reported.httpAttempts ?? 0;
      if (reported.inputTokens !== undefined) {
        metrics.inputTokens = (metrics.inputTokens ?? 0) + reported.inputTokens;
      }
      if (reported.outputTokens !== undefined) {
        metrics.outputTokens = (metrics.outputTokens ?? 0) + reported.outputTokens;
      }
    };
    let repairAttempted = false;
    let story = await provider.generateStory(input, { onMetrics });
    let structuralValid = true;
    try {
      validateStoryGenerationResult(story, testCase.pageCount);
    } catch {
      structuralValid = false;
    }
    const qualityInput = storyGenerationInputToQualityInput(input);
    let quality = evaluateStoryQuality(story, qualityInput);
    const repairRequired = !quality.overallPassed;
    if (
      repairRequired &&
      provider.repairStory &&
      quality.issues
        .filter((issue) => issue.severity === 'error')
        .every((issue) => issue.repairable)
    ) {
      repairAttempted = true;
      story = await provider.repairStory(
        { generationInput: input, candidate: story, qualityReport: quality },
        { onMetrics },
      );
      try {
        validateStoryGenerationResult(story, testCase.pageCount);
      } catch {
        structuralValid = false;
      }
      quality = evaluateStoryQuality(story, qualityInput);
    }
    const actualPageCount = story.bookPreview.pages.length;
    const pageCountValid = actualPageCount === testCase.pageCount;
    const consistencyPassed = characterConsistencyPassed(story, input);
    const passed = structuralValid && pageCountValid && quality.overallPassed && consistencyPassed;
    const calls = 1 + (repairAttempted ? 1 : 0);
    results.push({
      caseId: testCase.caseId,
      language: testCase.language,
      age: testCase.age,
      themeCategory: testCase.themeCategory,
      requestedPageCount: testCase.pageCount,
      actualPageCount,
      provider: provider.providerName ?? 'unknown',
      ...(provider.modelName && { model: provider.modelName }),
      promptVersion,
      promptHash,
      passed,
      structuralValid,
      pageCountValid,
      qualityPassed: quality.overallPassed,
      qualityDimensions: quality.dimensions,
      characterConsistencyPassed: consistencyPassed,
      issueCodes: quality.issues.map((issue) => issue.code),
      repairRequired,
      repairAttempted,
      durationMs: Date.now() - startedAt,
      logicalProviderCalls: calls,
      httpAttempts: metrics.httpAttempts,
      ...(metrics.inputTokens !== undefined && { inputTokens: metrics.inputTokens }),
      ...(metrics.outputTokens !== undefined && { outputTokens: metrics.outputTokens }),
      ...(estimatedCostPerCallUsd !== undefined && {
        estimatedCostUsd: calls * estimatedCostPerCallUsd,
      }),
    });
  }
  return results;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function renderStoryEvalComparison(
  baseline: readonly StoryEvalCaseResult[],
  candidate: readonly StoryEvalCaseResult[],
  labels: { baseline: string; candidate: string } = {
    baseline: 'baseline',
    candidate: 'candidate',
  },
): string {
  const row = (label: string, read: (results: readonly StoryEvalCaseResult[]) => string) =>
    `| ${label} | ${read(baseline)} | ${read(candidate)} |`;
  const valid = (results: readonly StoryEvalCaseResult[]) =>
    `${results.filter((result) => result.passed).length}/${results.length}`;
  const count = (
    results: readonly StoryEvalCaseResult[],
    key: 'repairRequired' | 'repairAttempted',
  ) => String(results.filter((result) => result[key]).length);
  const avg = (
    results: readonly StoryEvalCaseResult[],
    key: 'inputTokens' | 'outputTokens' | 'durationMs' | 'estimatedCostUsd',
  ) =>
    average(results.map((result) => result[key] ?? 0)).toFixed(key === 'estimatedCostUsd' ? 4 : 1);
  return [
    '# Story evaluation comparison',
    '',
    `| Metric | ${labels.baseline} | ${labels.candidate} |`,
    '| --- | ---: | ---: |',
    row('valid generations', valid),
    row('repair required', (results) => count(results, 'repairRequired')),
    row('repair attempted', (results) => count(results, 'repairAttempted')),
    row('avg input tokens', (results) => avg(results, 'inputTokens')),
    row('avg output tokens', (results) => avg(results, 'outputTokens')),
    row('avg estimated cost USD', (results) => avg(results, 'estimatedCostUsd')),
    row('avg latency ms', (results) => avg(results, 'durationMs')),
    '',
    'Quality remains a pass/fail issue contract; this comparison does not invent a subjective score.',
    '',
  ].join('\n');
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'mock';
  let provider: StoryGenerationProvider;
  let cases: readonly StoryEvalCase[] = STORY_EVAL_CASES;
  let estimatedCostPerCallUsd: number | undefined;

  if (mode === 'openai') {
    if (process.env['RUN_PAID_AI_EVALS'] !== 'true') {
      throw new Error('Paid AI evaluation requires RUN_PAID_AI_EVALS=true');
    }
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) throw new Error('Paid AI evaluation requires OPENAI_API_KEY');
    const requestedCases = readPositiveInt(process.env['AI_EVAL_MAX_CASES'], 3);
    const caseCount = Math.min(requestedCases, 5);
    cases = STORY_EVAL_CASES.slice(0, caseCount);
    assertPaidProviderCallBudget(cases.length * 2, resolveMaxPaidProviderCallsPerRun());
    const configuredCost = Number(process.env['OPENAI_STORY_ESTIMATED_COST_USD']);
    if (Number.isFinite(configuredCost) && configuredCost >= 0) {
      estimatedCostPerCallUsd = configuredCost;
      const ceiling = Number(process.env['AI_EVAL_MAX_ESTIMATED_COST_USD']);
      if (Number.isFinite(ceiling) && cases.length * 2 * configuredCost > ceiling) {
        throw new Error('Paid AI evaluation estimated-cost ceiling would be exceeded');
      }
    }
    provider = new OpenAIStoryGenerationProvider({ apiKey });
  } else if (mode === 'mock') {
    provider = new MockStoryGenerationProvider();
  } else {
    throw new Error(`Unknown story evaluation mode: ${mode}`);
  }

  const results = await evaluateStoryCases(provider, cases, estimatedCostPerCallUsd);
  console.table(
    results.map(({ promptHash, ...safe }) => ({ ...safe, promptHash: promptHash.slice(0, 12) })),
  );
  const artifactPath = process.env['AI_EVAL_JSON_PATH'];
  if (artifactPath) {
    await writeFile(artifactPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  }
  const baselinePath = process.env['AI_EVAL_BASELINE_JSON_PATH'];
  if (baselinePath) {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as StoryEvalCaseResult[];
    const comparison = renderStoryEvalComparison(baseline, results, {
      baseline: process.env['AI_EVAL_BASELINE_LABEL'] ?? 'baseline',
      candidate: process.env['AI_EVAL_CANDIDATE_LABEL'] ?? provider.promptVersion ?? 'candidate',
    });
    console.log(comparison);
    const comparisonPath = process.env['AI_EVAL_COMPARISON_PATH'];
    if (comparisonPath) await writeFile(comparisonPath, comparison, 'utf8');
  }
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
