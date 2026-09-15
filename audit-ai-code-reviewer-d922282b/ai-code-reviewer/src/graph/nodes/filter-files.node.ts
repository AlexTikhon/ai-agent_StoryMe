import type {
	FilteredFile,
	ReviewerState,
	ReviewerStateUpdate,
	SkippedFile
} from "../state.js";
import { classifyFile, isReviewableFileType } from "../../review/file-classifier.js";
import { loadIgnoreRules, isIgnoredPath } from "../../review/ignore.js";
import { getMaxPatchLength, truncatePatch } from "../../review/patch.js";

export async function filterFilesNode(
	state: ReviewerState
): Promise<ReviewerStateUpdate> {
	const files = state.files ?? [];
	const filteredFiles: FilteredFile[] = [];
	const skippedFiles: SkippedFile[] = [];
	const ignoreRules = await loadIgnoreRules(
		state.localRepoPath ?? process.cwd()
	);
	const maxPatchLength = getMaxPatchLength();

	for (const file of files) {
		const fileType = classifyFile(file.filename);

		if (isIgnoredPath(file.filename, ignoreRules)) {
			skippedFiles.push({
				filename: file.filename,
				fileType,
				reason: "ignored_by_user",
				details: "Matched .ai-reviewer-ignore."
			});
			continue;
		}

		if (!file.patch) {
			skippedFiles.push({
				filename: file.filename,
				fileType,
				reason: "missing_patch",
				details: "GitHub did not return a textual patch for this file."
			});
			continue;
		}

		if (fileType === "generated") {
			skippedFiles.push({
				filename: file.filename,
				fileType,
				reason: "generated_file",
				details: "Generated artifact or snapshot file."
			});
			continue;
		}

		if (!isReviewableFileType(fileType)) {
			skippedFiles.push({
				filename: file.filename,
				fileType,
				reason: "unsupported_file_type",
				details: `File classified as ${fileType}.`
			});
			continue;
		}

		filteredFiles.push({
			filename: file.filename,
			patch:
				file.patch.length >= maxPatchLength
					? truncatePatch(file.patch)
					: file.patch,
			fileType,
			isTruncated: file.patch.length >= maxPatchLength || undefined,
			originalPatchLength:
				file.patch.length >= maxPatchLength ? file.patch.length : undefined
		});
	}

	return { filteredFiles, skippedFiles };
}
