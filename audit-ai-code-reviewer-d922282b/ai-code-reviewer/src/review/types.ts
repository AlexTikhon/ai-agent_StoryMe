export type FindingCategory =
	| "correctness"
	| "security"
	| "performance"
	| "type-safety"
	| "error-handling"
	| "maintainability";

export type FindingConfidence = "low" | "medium" | "high";

export type ReviewerFinding = {
	severity: "high" | "medium" | "low";
	category: FindingCategory;
	confidence: FindingConfidence;
	filename: string;
	title: string;
	explanation: string;
	lineHint?: string;
	suggestion?: string;
};

export type ReviewedFileType =
	| "source"
	| "test"
	| "config"
	| "docs"
	| "lockfile"
	| "generated"
	| "binary"
	| "unknown";

export type SkippedFileReason =
	| "large_patch"
	| "missing_patch"
	| "unsupported_file_type"
	| "generated_file"
	| "ignored_by_user";

export type FilteredFile = {
	filename: string;
	patch: string;
	fileType: ReviewedFileType;
	isTruncated?: boolean;
	originalPatchLength?: number;
};

export type SkippedFile = {
	filename: string;
	fileType: ReviewedFileType;
	reason: SkippedFileReason;
	details?: string;
};
