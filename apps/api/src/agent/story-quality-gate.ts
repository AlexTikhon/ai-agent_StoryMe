import type {
  QualityIssue,
  QualityIssueCode,
  QualityIssueCategory,
  QualityReport,
} from '@book/types';
import type { StoryGenerationInput, StoryGenerationResult } from './story-generation-provider';

export interface StoryQualityGateInput {
  childName: string;
  childAge: number;
  language: string;
  theme: string;
  educationalMessage?: string;
}

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const MARKUP_OR_URL = /(?:https?:\/\/|www\.|<\s*\/?\s*[a-z][^>]*>)/iu;

const SAFE_MESSAGES: Record<QualityIssueCode, string> = {
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
  unsafe_control_characters: 'Generated content contains unsupported control characters.',
  unexpected_markup_or_url: 'Generated content contains unexpected markup or a URL.',
};

function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function wordCount(value: string): number {
  const normalized = value.trim();
  return normalized === '' ? 0 : normalized.split(/\s+/u).length;
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
  options: { pageNumber?: number; repairable?: boolean; severity?: 'warning' | 'error' } = {},
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

/**
 * Pure Phase 5A gate. Shape/cross-page cardinality remains owned by
 * validateStoryGenerationResult; this layer evaluates deterministic product
 * quality without provider calls, content logging, or autonomous repair.
 */
export function evaluateStoryQuality(
  result: StoryGenerationResult,
  input: StoryQualityGateInput,
): QualityReport {
  const issues: QualityIssue[] = [];
  const metadata = result.bookPreview.metadata;

  if (normalize(metadata.language) !== normalize(input.language)) {
    issues.push(issue('metadata_language_mismatch', 'alignment'));
  }
  if (normalize(metadata.theme) !== normalize(input.theme)) {
    issues.push(issue('metadata_theme_mismatch', 'alignment'));
  }
  if (metadata.childAge !== input.childAge) {
    issues.push(issue('metadata_age_mismatch', 'alignment'));
  }
  if (normalize(result.bookPreview.cover.childName) !== normalize(input.childName)) {
    issues.push(issue('cover_child_name_mismatch', 'consistency'));
  }

  const storyTexts = result.bookPreview.pages.map((page) => page.text);
  const normalizedChildName = normalize(input.childName);
  if (
    normalizedChildName !== '' &&
    !storyTexts.some((text) => normalize(text).includes(normalizedChildName))
  ) {
    issues.push(issue('child_name_missing_from_story', 'consistency'));
  }

  if (
    input.educationalMessage !== undefined &&
    normalize(result.storyPlan.educationalMessage) !== normalize(input.educationalMessage)
  ) {
    issues.push(issue('educational_message_mismatch', 'alignment'));
  }

  const maxWords = maximumWordsPerPage(input.childAge);
  const firstPageByText = new Map<string, number>();
  for (const previewPage of result.bookPreview.pages) {
    const planPage = result.storyPlan.pages.find(
      (candidate) => candidate.pageNumber === previewPage.pageNumber,
    );
    if (!planPage) continue;

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

    const words = wordCount(previewPage.text);
    if (words < 3) {
      issues.push(
        issue('page_text_too_short', 'age_appropriateness', {
          pageNumber: previewPage.pageNumber,
        }),
      );
    } else if (words > maxWords) {
      issues.push(
        issue('page_text_too_long', 'age_appropriateness', {
          pageNumber: previewPage.pageNumber,
        }),
      );
    }

    const normalizedText = normalize(previewPage.text);
    const firstPage = firstPageByText.get(normalizedText);
    if (normalizedText !== '' && firstPage !== undefined) {
      issues.push(
        issue('duplicate_page_text', 'consistency', { pageNumber: previewPage.pageNumber }),
      );
    } else if (normalizedText !== '') {
      firstPageByText.set(normalizedText, previewPage.pageNumber);
    }

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
    ...(input.educationalMessage !== undefined && {
      educationalMessage: input.educationalMessage,
    }),
  };
}
