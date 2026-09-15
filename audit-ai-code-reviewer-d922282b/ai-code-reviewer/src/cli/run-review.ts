import { createReviewerGraph } from "../graph/reviewer.graph.js";
import type { ReviewerState } from "../graph/state.js";
import type { CliArgs } from "./args.js";

function mergeStateUpdate(
	current: Partial<ReviewerState>,
	update: Partial<ReviewerState>
): Partial<ReviewerState> {
	return {
		...current,
		...update,
		errors: update.errors ?? current.errors,
		findings: update.findings ?? current.findings,
		filteredFiles: update.filteredFiles ?? current.filteredFiles,
		files: update.files ?? current.files,
		skippedFiles: update.skippedFiles ?? current.skippedFiles,
		summary: update.summary ?? current.summary
	};
}

export async function runReview(args: CliArgs): Promise<Partial<ReviewerState>> {
	const graph = createReviewerGraph();
	let result: Partial<ReviewerState> = {};
	const stream = await graph.stream(args, { streamMode: "updates" });

	for await (const chunk of stream) {
		for (const nodeUpdate of Object.values(
			chunk as Record<string, Partial<ReviewerState>>
		)) {
			result = mergeStateUpdate(result, nodeUpdate);
		}
	}

	return result;
}
