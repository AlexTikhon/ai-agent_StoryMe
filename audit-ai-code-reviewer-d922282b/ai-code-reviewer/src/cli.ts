import "dotenv/config";
import { errorLabel } from "./cli/console.js";
import { parseArgs } from "./cli/args.js";
import { printReviewResult, printReviewStart, printUsage } from "./cli/output.js";
import { runReview } from "./cli/run-review.js";
import type { CliArgs } from "./cli/args.js";

function exitWithUsage(message: string): never {
	console.error(`${errorLabel("[error]")} ${message}`);
	printUsage();
	process.exit(1);
}

function parseArgsOrExit(argv: string[]): CliArgs {
	try {
		return parseArgs(argv);
	} catch (error) {
		return exitWithUsage(
			error instanceof Error ? error.message : "Invalid arguments"
		);
	}
}

async function main() {
	const args = parseArgsOrExit(process.argv.slice(2));
	printReviewStart(args);
	const result = await runReview(args);
	printReviewResult(args, result);
}

main().catch((error) => {
	console.error(`${errorLabel("[fatal]")} ${String(error)}`);
	process.exit(1);
});
