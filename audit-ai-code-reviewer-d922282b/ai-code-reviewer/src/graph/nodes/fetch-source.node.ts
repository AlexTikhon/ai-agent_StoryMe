import type { ReviewerState, ReviewerStateUpdate } from "../state.js";
import { fetchPrNode } from "./fetch-pr.node.js";
import { fetchLocalDiffNode } from "./fetch-local-diff.node.js";

export async function fetchSourceNode(
	state: ReviewerState
): Promise<ReviewerStateUpdate> {
	if (state.reviewMode === "local") {
		return fetchLocalDiffNode(state);
	}

	return fetchPrNode(state);
}
