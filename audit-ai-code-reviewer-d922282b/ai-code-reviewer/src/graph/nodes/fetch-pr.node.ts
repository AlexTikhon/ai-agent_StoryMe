import type { ReviewerState, ReviewerStateUpdate } from "../state.js";
import {
	getPullRequest,
	getPullRequestFiles
} from "../../review-sources/github/pulls.js";
import { progressLabel, successLabel } from "../../cli/console.js";

export async function fetchPrNode(
	state: ReviewerState
): Promise<ReviewerStateUpdate> {
	try {
		if (!state.owner || !state.repo || state.pullNumber === undefined) {
			throw new Error("PR review mode requires owner, repo, and pullNumber");
		}

		console.log(
			`${progressLabel("[fetch]")} Loading PR ${state.owner}/${state.repo}#${state.pullNumber}...`
		);
		const pr = await getPullRequest(state.owner, state.repo, state.pullNumber);
		const files = await getPullRequestFiles(
			state.owner,
			state.repo,
			state.pullNumber
		);
		console.log(
			`${successLabel("[fetch]")} Found ${files.length} PR file(s).`
		);

		return {
			prTitle: pr.title,
			prBody: pr.body ?? "",
			baseRef: pr.base.ref,
			headRef: pr.head.ref,
			files
		};
	} catch (error) {
		return {
			errors: [
				...(state.errors ?? []),
				error instanceof Error ? error.message : "Unknown fetchPrNode error"
			]
		};
	}
}
