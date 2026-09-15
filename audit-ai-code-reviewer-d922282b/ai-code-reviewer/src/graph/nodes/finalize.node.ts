import type { ReviewerState, ReviewerStateUpdate } from "../state.js";

export async function finalizeNode(
	state: ReviewerState
): Promise<ReviewerStateUpdate> {
	const findings = state.findings ?? [];
	const skippedFiles = state.skippedFiles ?? [];
	const skippedText = `Skipped files: ${skippedFiles.length}.`;
	const categoryCounts = findings.reduce(
		(acc, item) => {
			acc[item.category] = (acc[item.category] ?? 0) + 1;
			return acc;
		},
		{} as Record<string, number>
	);
	const categorySummary = Object.entries(categoryCounts)
		.map(([category, count]) => `${category}=${count}`)
		.join(", ");
	const skippedReasonCounts = skippedFiles.reduce(
		(acc, item) => {
			acc[item.reason] = (acc[item.reason] ?? 0) + 1;
			return acc;
		},
		{} as Record<string, number>
	);
	const skippedReasonSummary = Object.entries(skippedReasonCounts)
		.map(([reason, count]) => `${reason}=${count}`)
		.join(", ");

	if (!findings.length) {
		const header = `Review completed. Findings: high=0, medium=0, low=0. Categories: none. ${skippedText} Skipped reasons: ${
			skippedReasonSummary || "none"
		}.`;
		return {
			summary: `${header}\n\n${
				state.summary || "No meaningful issues found in the reviewed patch."
			}`.trim()
		};
	}

	const counts = findings.reduce(
		(acc, item) => {
			acc[item.severity]++;
			return acc;
		},
		{ high: 0, medium: 0, low: 0 }
	);

	const header = `Review completed. Findings: high=${counts.high}, medium=${counts.medium}, low=${counts.low}. Categories: ${
		categorySummary || "none"
	}. ${skippedText} Skipped reasons: ${skippedReasonSummary || "none"}.`;

	return {
		summary: `${header}\n\n${state.summary ?? ""}`.trim()
	};
}
