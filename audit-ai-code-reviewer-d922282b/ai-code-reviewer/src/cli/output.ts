import type { ReviewerState } from "../graph/state.js";
import type { ReviewerFinding } from "../review/types.js";
import {
	consoleStyles,
	errorLabel,
	progressLabel,
	sectionTitle,
	severityBadge
} from "./console.js";
import type { CliArgs } from "./args.js";

export function printUsage() {
	console.error(sectionTitle("Usage"));
	console.error(
		`  ${consoleStyles.dim("npm run review -- <owner> <repo> <pullNumber>")}`
	);
	console.error(
		`  ${consoleStyles.dim(
			"npm run review -- --local [--base <ref>] [--repo <path>]"
		)}`
	);
}

export function printReviewStart(args: CliArgs) {
	if (args.reviewMode === "local") {
		console.log(
			args.localBaseRef
				? `${progressLabel("[review]")} Starting local diff review against ${consoleStyles.bold(args.localBaseRef)}...`
				: `${progressLabel("[review]")} Starting local diff review against ${consoleStyles.bold("HEAD")}...`
		);
		if (args.localRepoPath) {
			console.log(
				`${progressLabel("[review]")} Repository path: ${consoleStyles.bold(args.localRepoPath)}`
			);
		}
		return;
	}

	console.log(
		`${progressLabel("[review]")} Starting PR review for ${consoleStyles.bold(
			`${args.owner}/${args.repo}#${args.pullNumber}`
		)}...`
	);
}

export function printFinding(finding: ReviewerFinding, index: number) {
	console.log(
		`${consoleStyles.bold(`${index}.`)} [${severityBadge(
			finding.severity
		)}] ${consoleStyles.bold(finding.filename)}`
	);
	console.log(
		`   ${finding.title} ${consoleStyles.dim(
			`(${finding.category}, confidence=${finding.confidence})`
		)}`
	);
	console.log(`   ${finding.explanation}`);
	if (finding.lineHint) {
		console.log(
			`   ${consoleStyles.magenta("Line hint:")} ${finding.lineHint}`
		);
	}
	if (finding.suggestion) {
		console.log(
			`   ${consoleStyles.green("Suggestion:")} ${finding.suggestion}`
		);
	}
	console.log("");
}

export function printReviewResult(
	args: CliArgs,
	result: Partial<ReviewerState>
) {
	if (result.errors?.length) {
		console.error(`\n${sectionTitle("Errors")}\n`);
		for (const error of result.errors) {
			console.error(`${errorLabel("*")} ${error}`);
		}
	}

	console.log(`\n${sectionTitle("=== SUMMARY ===")}\n`);
	console.log(result.summary ?? "No summary");

	console.log(`\n${sectionTitle("=== REVIEW TARGET ===")}\n`);
	if (args.reviewMode === "local") {
		console.log(
			args.localBaseRef
				? `Local git diff against ${consoleStyles.bold(args.localBaseRef)}`
				: `Local git diff against ${consoleStyles.bold("HEAD")}`
		);
		if (args.localRepoPath) {
			console.log(`Repository: ${consoleStyles.bold(args.localRepoPath)}`);
		}
	} else {
		console.log(
			consoleStyles.bold(`${args.owner}/${args.repo}#${args.pullNumber}`)
		);
	}

	console.log(`\n${sectionTitle("=== FINDINGS ===")}\n`);
	for (const [index, finding] of (result.findings ?? []).entries()) {
		printFinding(finding, index + 1);
	}
}
