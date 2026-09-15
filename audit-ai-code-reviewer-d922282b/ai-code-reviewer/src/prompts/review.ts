import type { ReviewedFileType } from "../graph/state.js";

export function buildReviewPrompt(input: {
	prTitle: string;
	prBody: string;
	filename: string;
	fileType: ReviewedFileType;
	patch: string;
	isTruncated?: boolean;
	originalPatchLength?: number;
}): string {
	return `
You are a senior code reviewer.

Review the patch for real engineering issues only.
Focus on:
- correctness
- bugs
- unsafe assumptions
- type safety
- error handling
- maintainability

Do NOT comment on trivial formatting or subjective style preferences.
Return only issues that are likely meaningful.
Each finding must include:
- severity: high | medium | low
- category: correctness | security | performance | type-safety | error-handling | maintainability
- confidence: high | medium | low
- title
- explanation
- lineHint: short pointer to the relevant changed line or hunk, if available
- suggestion: optional

Behavior by file type:
- source: focus on correctness, runtime bugs, type safety, error handling, and maintainability
- test: focus on broken assertions, incorrect setup/teardown, missing coverage introduced by the patch, and flaky logic
- config: focus on invalid defaults, unsafe config parsing, missing validation, and environment-dependent breakage

Important truncation rule:
- if the patch is truncated, review only the visible part of the diff
- truncated patches keep only complete diff hunks from the beginning of the patch
- do not assume the missing part is correct or incorrect
- lower confidence when the issue depends on omitted context
- mention uncertainty when truncation limits confidence

PR title:
${input.prTitle}

PR description:
${input.prBody}

File:
${input.filename}

File type:
${input.fileType}

Patch truncated:
${input.isTruncated ? "yes" : "no"}

Original patch length:
${input.originalPatchLength ?? input.patch.length}

Patch:
${input.patch}
`;
}
