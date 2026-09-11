import { detectStoryLanguage, resolveLesson } from './story-language';
import type {
  QualityIssue,
  QualityIssueCode,
  QualityIssueCategory,
  QualityReport,
  StoryQualityDimensions,
} from '@book/types';
import {
  resolveTargetPageCount,
  type StoryGenerationInput,
  type StoryGenerationResult,
} from './story-generation-provider';

export interface StoryQualityGateInput {
  childName: string;
  childAge: number;
  language: string;
  theme: string;
  pageCount?: number;
  educationalMessage?: string;
}

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const MARKUP_OR_URL = /(?:https?:\/\/|www\.|<\s*\/?\s*[a-z][^>]*>)/iu;

const SAFE_MESSAGES: Record<QualityIssueCode, string> = {
  actual_language_mismatch: 'The story prose is confidently detected in a different language.',
  metadata_language_mismatch: 'Generated language metadata does not match the requested language.',
  metadata_theme_mismatch: 'Generated theme metadata does not match the requested theme.',
  metadata_age_mismatch: 'Generated age metadata does not match the requested age.',
  cover_child_name_mismatch: 'The cover does not identify the requested main character.',
  child_name_missing_from_story: 'The main character is not referenced in the story pages.',
  educational_message_mismatch: 'The generated lesson does not match the requested lesson.',
  page_text_mismatch: 'The story plan and preview disagree about a page text.',
  page_illustration_prompt_mismatch:
    'The story plan and preview disagree about a page illustration.',
  page_text_too_short: 'A story page is too short to be useful.',
  page_text_too_long: 'A story page exceeds the age-based length limit.',
  duplicate_page_text: 'Two story pages contain the same narration.',
  page_count_mismatch: 'The completed story does not contain the expected number of pages.',
  page_title_missing: 'A story page has no usable title.',
  page_text_missing: 'A story page has no narration.',
  story_title_missing: 'The completed story has no usable title.',
  character_card_name_mismatch: 'The story character does not match the requested protagonist.',
  protagonist_missing_from_opening: 'The requested protagonist is absent from the opening page.',
  protagonist_missing_from_ending: 'The requested protagonist is absent from the ending page.',
  protagonist_coverage_too_low: 'The requested protagonist disappears from too much of the story.',
  personalization_insufficient: 'The story does not contain enough deliberate personalization.',
  near_duplicate_page_text: 'Two story pages are effectively duplicates.',
  repeated_sentence: 'A complete sentence is repeated across story pages.',
  repeated_page_opening: 'Too many story pages begin with the same phrase.',
  repeated_page_closing: 'Too many story pages end with the same phrase.',
  page_scene_missing: 'A story page has no usable scene description.',
  page_progression_insufficient: 'The page scenes do not provide enough distinct progression.',
  ending_missing: 'The story has no usable resolution.',
  ending_not_reflected_in_final_page: 'The final page does not provide a distinct resolved ending.',
  unsafe_control_characters: 'Generated content contains unsupported control characters.',
  unexpected_markup_or_url: 'Generated content contains unexpected markup or a URL.',
};

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase();
}

function words(value: string): string[] {
  const normalized = normalize(value);
  return normalized === '' ? [] : normalized.split(' ');
}

function wordCount(value: string): number {
  return words(value).length;
}

function nameAppears(value: string, name: string): boolean {
  const needle = normalize(name);
  if (needle === '') return false;
  if (` ${normalize(value)} `.includes(` ${needle} `)) return true;
  // Conservative suffix handling for common Russian and Polish given-name inflections.
  if (needle.length < 3 || needle.includes(' ')) return false;
  const stem = needle.replace(/[aаяь]$/u, '');
  return words(value).some(
    (word) =>
      word.startsWith(stem) &&
      /^(?:a|y|i|ę|ą|ie|owi|em|а|я|ы|и|у|ю|е|ой|ей|ом|ем)$/u.test(word.slice(stem.length)),
  );
}

function sentences(value: string): string[] {
  return value
    .split(/[.!?。！？]+/u)
    .map(normalize)
    .filter((sentence) => wordCount(sentence) >= 5);
}

function edgePhrase(value: string, fromEnd: boolean): string {
  const tokens = words(value);
  const selected = fromEnd ? tokens.slice(-4) : tokens.slice(0, 4);
  return selected.length >= 3 ? selected.join(' ') : '';
}

function jaccardSimilarity(left: string, right: string): number {
  const leftTokens = new Set(words(left));
  const rightTokens = new Set(words(right));
  if (leftTokens.size < 8 || rightTokens.size < 8) return 0;
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : overlap / union;
}

export function maximumWordsPerPage(childAge: number): number {
  if (childAge <= 4) return 90;
  if (childAge <= 7) return 130;
  if (childAge <= 9) return 170;
  return 220;
}

function issue(
  code: QualityIssueCode,
  category: QualityIssueCategory,
  options: {
    pageNumber?: number | undefined;
    repairable?: boolean;
    severity?: 'warning' | 'error';
  } = {},
): QualityIssue {
  return {
    code,
    category,
    severity: options.severity ?? 'error',
    repairable: options.repairable ?? true,
    ...(options.pageNumber !== undefined && { pageNumber: options.pageNumber }),
    message: SAFE_MESSAGES[code],
  };
}

function containsUnsafeTechnicalContent(value: string): {
  controlCharacters: boolean;
  markupOrUrl: boolean;
} {
  return {
    controlCharacters: CONTROL_CHARACTERS.test(value),
    markupOrUrl: MARKUP_OR_URL.test(value),
  };
}

function dimensionPassed(
  issues: readonly QualityIssue[],
  codes: readonly QualityIssueCode[],
): boolean {
  return !issues.some((finding) => finding.severity === 'error' && codes.includes(finding.code));
}

function dimensionsFor(issues: readonly QualityIssue[]): StoryQualityDimensions {
  return {
    structuralValidity: dimensionPassed(issues, [
      'page_count_mismatch',
      'page_title_missing',
      'page_text_missing',
      'story_title_missing',
      'page_text_mismatch',
      'page_illustration_prompt_mismatch',
    ]),
    personalization: dimensionPassed(issues, [
      'metadata_theme_mismatch',
      'metadata_age_mismatch',
      'cover_child_name_mismatch',
      'child_name_missing_from_story',
      'educational_message_mismatch',
      'personalization_insufficient',
    ]),
    protagonistConsistency: dimensionPassed(issues, [
      'cover_child_name_mismatch',
      'character_card_name_mismatch',
      'child_name_missing_from_story',
      'protagonist_missing_from_opening',
      'protagonist_missing_from_ending',
      'protagonist_coverage_too_low',
    ]),
    ageAppropriateness: dimensionPassed(issues, ['page_text_too_short', 'page_text_too_long']),
    continuity: dimensionPassed(issues, [
      'page_scene_missing',
      'page_progression_insufficient',
      'protagonist_coverage_too_low',
      'page_text_mismatch',
      'page_illustration_prompt_mismatch',
    ]),
    repetitionAcceptable: dimensionPassed(issues, [
      'duplicate_page_text',
      'near_duplicate_page_text',
      'repeated_sentence',
      'repeated_page_opening',
      'repeated_page_closing',
    ]),
    pageProgression: dimensionPassed(issues, [
      'page_scene_missing',
      'page_progression_insufficient',
    ]),
    endingQuality: dimensionPassed(issues, [
      'ending_missing',
      'ending_not_reflected_in_final_page',
      'protagonist_missing_from_ending',
    ]),
  };
}

/** Pure deterministic product-quality gate. It performs no provider calls. */
export function evaluateStoryQuality(
  result: StoryGenerationResult,
  input: StoryQualityGateInput,
): QualityReport {
  const issues: QualityIssue[] = [];
  const metadata = result.bookPreview.metadata;
  const previewPages = result.bookPreview.pages;
  const expectedPageCount = resolveTargetPageCount(input.pageCount);

  if (normalize(result.storyPlan.title) === '' || normalize(result.bookPreview.title) === '') {
    issues.push(issue('story_title_missing', 'structure'));
  }
  if (previewPages.length !== expectedPageCount || metadata.totalPages !== expectedPageCount) {
    issues.push(issue('page_count_mismatch', 'structure'));
  }
  if (normalize(metadata.language) !== normalize(input.language)) {
    issues.push(issue('metadata_language_mismatch', 'alignment'));
  }
  if (normalize(metadata.theme) !== normalize(input.theme)) {
    issues.push(issue('metadata_theme_mismatch', 'alignment'));
  }
  if (metadata.childAge !== input.childAge)
    issues.push(issue('metadata_age_mismatch', 'alignment'));
  if (normalize(result.bookPreview.cover.childName) !== normalize(input.childName)) {
    issues.push(issue('cover_child_name_mismatch', 'personalization'));
  }
  if (normalize(result.characterCard.name) !== normalize(input.childName)) {
    issues.push(issue('character_card_name_mismatch', 'consistency'));
  }

  const storyTexts = previewPages.map((page) => page.text);
  const detectedLanguage = detectStoryLanguage(storyTexts.join(' '));
  if (detectedLanguage !== 'unknown' && detectedLanguage !== input.language)
    issues.push(issue('actual_language_mismatch', 'alignment'));
  const namePages = previewPages.filter((page) => nameAppears(page.text, input.childName));
  if (namePages.length === 0) {
    issues.push(issue('child_name_missing_from_story', 'personalization'));
  } else {
    const firstPage = previewPages[0];
    const lastPage = previewPages.at(-1);
    if (firstPage && !nameAppears(firstPage.text, input.childName)) {
      issues.push(
        issue('protagonist_missing_from_opening', 'continuity', {
          pageNumber: firstPage.pageNumber,
        }),
      );
    }
    if (lastPage && !nameAppears(lastPage.text, input.childName)) {
      issues.push(
        issue('protagonist_missing_from_ending', 'ending', { pageNumber: lastPage.pageNumber }),
      );
    }
    if (namePages.length < Math.max(2, Math.ceil(previewPages.length / 3))) {
      issues.push(issue('protagonist_coverage_too_low', 'continuity'));
    }
  }

  if (
    namePages.length === 0 ||
    normalize(metadata.theme) !== normalize(input.theme) ||
    metadata.childAge !== input.childAge
  ) {
    issues.push(issue('personalization_insufficient', 'personalization'));
  }
  if (
    input.educationalMessage !== undefined &&
    normalize(result.storyPlan.educationalMessage) !== normalize(input.educationalMessage)
  ) {
    const expected = resolveLesson(input.educationalMessage);
    const actual = resolveLesson(result.storyPlan.educationalMessage);
    if (!(
      expected.kind === 'predefined' &&
      actual.kind === 'predefined' &&
      expected.id === actual.id
    )) {
      // Equivalence of arbitrary translations is semantic, not a structural guarantee.
      issues.push(
        issue('educational_message_mismatch', 'personalization', {
          severity: 'warning',
          repairable: false,
        }),
      );
    }
  }

  const maxWords = maximumWordsPerPage(input.childAge);
  const firstPageByText = new Map<string, number>();
  const sentenceOccurrences = new Map<string, { firstPage: number; count: number }>();
  const openings = new Map<string, number[]>();
  const closings = new Map<string, number[]>();
  const scenes: string[] = [];

  for (const previewPage of previewPages) {
    const planPage = result.storyPlan.pages.find(
      (candidate) => candidate.pageNumber === previewPage.pageNumber,
    );
    if (normalize(previewPage.title) === '') {
      issues.push(issue('page_title_missing', 'structure', { pageNumber: previewPage.pageNumber }));
    }
    if (normalize(previewPage.text) === '') {
      issues.push(issue('page_text_missing', 'structure', { pageNumber: previewPage.pageNumber }));
    }
    if (!planPage) continue;

    const normalizedScene = normalize(planPage.sceneDescription);
    scenes.push(normalizedScene);
    if (normalizedScene === '') {
      issues.push(
        issue('page_scene_missing', 'progression', { pageNumber: previewPage.pageNumber }),
      );
    }
    if (normalize(planPage.storyText ?? '') !== normalize(previewPage.text)) {
      issues.push(
        issue('page_text_mismatch', 'consistency', { pageNumber: previewPage.pageNumber }),
      );
    }
    const plannedIllustrationPrompt = planPage.illustration?.prompt ?? planPage.illustrationPrompt;
    if (normalize(plannedIllustrationPrompt) !== normalize(previewPage.illustrationPrompt)) {
      issues.push(
        issue('page_illustration_prompt_mismatch', 'consistency', {
          pageNumber: previewPage.pageNumber,
        }),
      );
    }

    const count = wordCount(previewPage.text);
    if (count < 3) {
      issues.push(
        issue('page_text_too_short', 'age_appropriateness', { pageNumber: previewPage.pageNumber }),
      );
    } else if (count > maxWords) {
      issues.push(
        issue('page_text_too_long', 'age_appropriateness', { pageNumber: previewPage.pageNumber }),
      );
    }

    const normalizedText = normalize(previewPage.text);
    const duplicateOf = firstPageByText.get(normalizedText);
    if (normalizedText !== '' && duplicateOf !== undefined) {
      issues.push(
        issue('duplicate_page_text', 'repetition', { pageNumber: previewPage.pageNumber }),
      );
    } else if (normalizedText !== '') firstPageByText.set(normalizedText, previewPage.pageNumber);

    for (const sentence of sentences(previewPage.text)) {
      const occurrence = sentenceOccurrences.get(sentence);
      if (occurrence && occurrence.firstPage !== previewPage.pageNumber && occurrence.count >= 2) {
        issues.push(
          issue('repeated_sentence', 'repetition', { pageNumber: previewPage.pageNumber }),
        );
      }
      sentenceOccurrences.set(sentence, {
        firstPage: occurrence?.firstPage ?? previewPage.pageNumber,
        count: (occurrence?.count ?? 0) + 1,
      });
    }

    const opening = edgePhrase(previewPage.text, false);
    const closing = edgePhrase(previewPage.text, true);
    if (opening) openings.set(opening, [...(openings.get(opening) ?? []), previewPage.pageNumber]);
    if (closing) closings.set(closing, [...(closings.get(closing) ?? []), previewPage.pageNumber]);

    for (const value of [
      previewPage.title,
      previewPage.text,
      previewPage.illustrationPrompt,
      previewPage.learningGoal,
    ]) {
      const unsafe = containsUnsafeTechnicalContent(value);
      if (unsafe.controlCharacters) {
        issues.push(
          issue('unsafe_control_characters', 'safety', {
            pageNumber: previewPage.pageNumber,
            repairable: false,
          }),
        );
      }
      if (unsafe.markupOrUrl) {
        issues.push(
          issue('unexpected_markup_or_url', 'safety', {
            pageNumber: previewPage.pageNumber,
            repairable: false,
          }),
        );
      }
    }
  }

  for (let right = 1; right < previewPages.length; right++) {
    for (let left = 0; left < right; left++) {
      if (jaccardSimilarity(storyTexts[left] ?? '', storyTexts[right] ?? '') >= 0.82) {
        issues.push(
          issue('near_duplicate_page_text', 'repetition', {
            pageNumber: previewPages[right]?.pageNumber,
          }),
        );
        break;
      }
    }
  }

  const edgeThreshold = Math.max(3, Math.ceil(previewPages.length * 0.6));
  const repeatedOpening = [...openings.values()].find((pages) => pages.length >= edgeThreshold);
  const repeatedClosing = [...closings.values()].find((pages) => pages.length >= edgeThreshold);
  if (repeatedOpening)
    issues.push(
      issue('repeated_page_opening', 'repetition', { pageNumber: repeatedOpening.at(-1) }),
    );
  if (repeatedClosing)
    issues.push(
      issue('repeated_page_closing', 'repetition', { pageNumber: repeatedClosing.at(-1) }),
    );

  const distinctSceneCount = new Set(scenes.filter(Boolean)).size;
  if (previewPages.length > 1 && distinctSceneCount < Math.ceil(previewPages.length * 0.6)) {
    issues.push(issue('page_progression_insufficient', 'progression'));
  }

  const resolution = result.storyPlan.resolution;
  const finalText = previewPages.at(-1)?.text ?? '';
  const firstText = previewPages[0]?.text ?? '';
  if (wordCount(resolution) < 3 || wordCount(finalText) < 3) {
    issues.push(issue('ending_missing', 'ending', { pageNumber: previewPages.at(-1)?.pageNumber }));
  } else if (
    normalize(finalText) === normalize(firstText) ||
    normalize(resolution) === normalize(result.storyPlan.openingHook)
  ) {
    issues.push(
      issue('ending_not_reflected_in_final_page', 'ending', {
        pageNumber: previewPages.at(-1)?.pageNumber,
      }),
    );
  }

  const deduplicatedIssues = [
    ...new Map(
      issues.map((finding) => [`${finding.code}:${finding.pageNumber ?? 'book'}`, finding]),
    ).values(),
  ];
  const flaggedPages = [
    ...new Set(
      deduplicatedIssues
        .map((finding) => finding.pageNumber)
        .filter((pageNumber): pageNumber is number => pageNumber !== undefined),
    ),
  ].sort((left, right) => left - right);

  return {
    version: 1,
    overallPassed: !deduplicatedIssues.some((finding) => finding.severity === 'error'),
    dimensions: dimensionsFor(deduplicatedIssues),
    issues: deduplicatedIssues,
    flaggedPages,
  };
}

export function storyGenerationInputToQualityInput(
  input: StoryGenerationInput,
): StoryQualityGateInput {
  return {
    childName: input.childName,
    childAge: input.childAge,
    language: input.language,
    theme: input.theme,
    ...(input.pageCount !== undefined && { pageCount: input.pageCount }),
    ...(input.educationalMessage !== undefined && { educationalMessage: input.educationalMessage }),
  };
}
