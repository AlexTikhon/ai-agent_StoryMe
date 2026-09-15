import { Annotation } from "@langchain/langgraph";
export type {
	FilteredFile,
	ReviewedFileType,
	ReviewerFinding,
	SkippedFile,
	SkippedFileReason
} from "../review/types.js";
import type {
	FilteredFile,
	ReviewerFinding,
	SkippedFile
} from "../review/types.js";

export const reviewerStateAnnotation = Annotation.Root({
	reviewMode: Annotation<"pr" | "local" | undefined>(),
	owner: Annotation<string | undefined>(),
	repo: Annotation<string | undefined>(),
	pullNumber: Annotation<number | undefined>(),
	localBaseRef: Annotation<string | undefined>(),
	localRepoPath: Annotation<string | undefined>(),

	prTitle: Annotation<string | undefined>(),
	prBody: Annotation<string | undefined>(),
	baseRef: Annotation<string | undefined>(),
	headRef: Annotation<string | undefined>(),

	files: Annotation<
		| Array<{
				filename: string;
				status: string;
				additions?: number;
				deletions?: number;
				changes?: number;
				patch?: string;
		  }>
		| undefined
	>(),

	filteredFiles: Annotation<FilteredFile[] | undefined>(),
	skippedFiles: Annotation<SkippedFile[] | undefined>(),

	findings: Annotation<ReviewerFinding[] | undefined>(),
	summary: Annotation<string | undefined>(),
	errors: Annotation<string[] | undefined>()
});

export type ReviewerState = typeof reviewerStateAnnotation.State;
export type ReviewerStateUpdate = typeof reviewerStateAnnotation.Update;
