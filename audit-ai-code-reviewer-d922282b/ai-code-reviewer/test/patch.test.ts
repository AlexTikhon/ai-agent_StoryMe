import assert from "node:assert/strict";
import {
	getMaxPatchLength,
	splitPatchIntoSections,
	truncatePatch
} from "../src/review/patch.js";
import { unitTest } from "./helpers.js";

unitTest("splitPatchIntoSections separates preamble and hunks", () => {
	const patch = [
		"diff --git a/a.ts b/a.ts",
		"index 123..456 100644",
		"--- a/a.ts",
		"+++ b/a.ts",
		"@@ -1 +1 @@",
		"-old",
		"+new",
		"@@ -3 +3 @@",
		"-before",
		"+after"
	].join("\n");

	assert.deepEqual(splitPatchIntoSections(patch), {
		preamble: ["diff --git a/a.ts b/a.ts", "index 123..456 100644", "--- a/a.ts", "+++ b/a.ts"].join("\n"),
		hunks: ["@@ -1 +1 @@\n-old\n+new", "@@ -3 +3 @@\n-before\n+after"]
	});
});

unitTest("truncatePatch preserves complete first hunk and appends marker", () => {
	const oversizedLine = "x".repeat(getMaxPatchLength());
	const patch = [
		"diff --git a/a.ts b/a.ts",
		"@@ -1 +1 @@",
		`+${oversizedLine}`,
		"@@ -2 +2 @@",
		"+small"
	].join("\n");

	const truncated = truncatePatch(patch);

	assert.match(truncated, /\[TRUNCATED: kept 1\/2 complete hunk\(s\) within review size limit\]$/);
	assert.match(truncated, /@@ -1 \+1 @@/);
	assert.doesNotMatch(truncated, /@@ -2 \+2 @@/);
});

unitTest("truncatePatch handles patches without hunks", () => {
	const truncated = truncatePatch("a".repeat(getMaxPatchLength() + 10));

	assert.match(
		truncated,
		/\[TRUNCATED: patch exceeded review size limit and had no detectable hunks\]$/
	);
});
