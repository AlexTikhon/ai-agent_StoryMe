import type { ReviewerState, ReviewerStateUpdate } from "../state.js";
import { progressLabel, successLabel } from "../../cli/console.js";
import { getLocalDiff } from "../../review-sources/local/local.js";

export async function fetchLocalDiffNode(
	state: ReviewerState
): Promise<ReviewerStateUpdate> {
	try {
		console.log(`${progressLabel("[fetch]")} Collecting local git diff...`);
		const diff = await getLocalDiff(state.localBaseRef, state.localRepoPath);
		console.log(
			`${successLabel("[fetch]")} Found ${diff.files.length} changed local file(s).`
		);

		return {
			prTitle: diff.title,
			prBody: diff.body,
			baseRef: diff.baseRef,
			headRef: diff.headRef,
			files: diff.files
		};
	} catch (error) {
		return {
			errors: [
				...(state.errors ?? []),
				error instanceof Error
					? error.message
					: "Unknown fetchLocalDiffNode error"
			]
		};
	}
}
