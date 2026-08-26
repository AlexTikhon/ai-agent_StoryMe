import { MockCharacterProfileProvider } from '../src/agent/character-profile-provider';
import { MockStoryGenerationProvider } from '../src/agent/story-generation-provider';
import { evaluateStoryQuality } from '../src/agent/story-quality-gate';
import {
  MALFORMED_STORY_FIXTURES,
  OFFLINE_STORY_FIXTURES,
  type OfflineStoryFixture,
} from './story-quality-evaluation.fixtures';

export interface OfflineEvaluationCaseResult {
  id: string;
  kind: 'good' | 'malformed';
  passed: boolean;
  expectedIssue?: string;
  issueCodes: string[];
}

async function buildStory(fixture: OfflineStoryFixture) {
  const input = { bookId: `offline-${fixture.id}`, ...fixture };
  const characterProfile = await new MockCharacterProfileProvider().buildProfile(input);
  const story = await new MockStoryGenerationProvider().generateStory({
    ...input,
    characterProfile,
  });
  return { input, story };
}

export async function runOfflineStoryEvaluation(): Promise<OfflineEvaluationCaseResult[]> {
  const results: OfflineEvaluationCaseResult[] = [];
  for (const fixture of OFFLINE_STORY_FIXTURES) {
    const { input, story } = await buildStory(fixture);
    const report = evaluateStoryQuality(story, input);
    results.push({
      id: fixture.id,
      kind: 'good',
      passed: report.overallPassed && Object.values(report.dimensions).every(Boolean),
      issueCodes: report.issues.map((issue) => issue.code),
    });
  }

  const baseFixture = OFFLINE_STORY_FIXTURES.find((fixture) => fixture.pageCount === 6)!;
  for (const malformed of MALFORMED_STORY_FIXTURES) {
    const { input, story } = await buildStory(baseFixture);
    malformed.mutate(story, baseFixture);
    const report = evaluateStoryQuality(story, input);
    const issueCodes = report.issues.map((issue) => issue.code);
    results.push({
      id: malformed.id,
      kind: 'malformed',
      passed: !report.overallPassed && issueCodes.includes(malformed.expectedIssue),
      expectedIssue: malformed.expectedIssue,
      issueCodes,
    });
  }
  return results;
}

async function main(): Promise<void> {
  const results = await runOfflineStoryEvaluation();
  const failed = results.filter((result) => !result.passed);
  console.log('Story quality evaluation');
  console.log('');
  console.log(`Cases: ${results.length}`);
  console.log(`Passed: ${results.length - failed.length}`);
  console.log(`Failed: ${failed.length}`);
  console.log('External API calls: 0');
  console.log('API keys required: 0');
  console.log('');
  for (const result of results) {
    const expectation = result.expectedIssue ? ` (expects ${result.expectedIssue})` : '';
    const issues =
      result.passed || result.issueCodes.length === 0 ? '' : ` [${result.issueCodes.join(', ')}]`;
    console.log(
      `${result.passed ? 'PASS' : 'FAIL'} ${result.kind.padEnd(9)} ${result.id}${expectation}${issues}`,
    );
  }
  if (failed.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
