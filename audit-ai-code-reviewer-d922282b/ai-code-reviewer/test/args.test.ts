import assert from "node:assert/strict";
import { parseArgs } from "../src/cli/args.js";
import { unitTest } from "./helpers.js";

unitTest("parseArgs parses PR review arguments", () => {
	assert.deepEqual(parseArgs(["openai", "repo", "42"]), {
		reviewMode: "pr",
		owner: "openai",
		repo: "repo",
		pullNumber: 42
	});
});

unitTest("parseArgs parses local review arguments", () => {
	assert.deepEqual(parseArgs(["--local", "--base", "main", "--repo", "C:\\repo"]), {
		reviewMode: "local",
		localBaseRef: "main",
		localRepoPath: "C:\\repo"
	});
});

unitTest("parseArgs throws on missing base value", () => {
	assert.throws(() => parseArgs(["--local", "--base"]), /--base requires a ref value/);
});

unitTest("parseArgs throws on invalid PR number", () => {
	assert.throws(() => parseArgs(["openai", "repo", "abc"]), /pullNumber must be a number/);
});
