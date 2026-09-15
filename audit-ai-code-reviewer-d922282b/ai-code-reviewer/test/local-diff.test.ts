import assert from "node:assert/strict";
import {
	countLines,
	countPatchStats,
	isProbablyBinary,
	parseNameStatus
} from "../src/review-sources/local/local.js";
import { unitTest } from "./helpers.js";

unitTest("parseNameStatus parses added modified deleted and renamed files", () => {
	const output = ["A\tsrc/new.ts", "M\tsrc/app.ts", "D\tsrc/old.ts", "R100\tsrc/was.ts\tsrc/now.ts"].join("\n");

	assert.deepEqual(parseNameStatus(output), [
		{ status: "added", filename: "src/new.ts" },
		{ status: "modified", filename: "src/app.ts" },
		{ status: "removed", filename: "src/old.ts" },
		{
			status: "renamed",
			previousFilename: "src/was.ts",
			filename: "src/now.ts"
		}
	]);
});

unitTest("countLines counts CRLF and LF consistently", () => {
	assert.equal(countLines("one\r\ntwo\nthree"), 3);
	assert.equal(countLines(""), 0);
});

unitTest("countPatchStats ignores headers and counts additions and deletions", () => {
	const patch = [
		"--- a/src/app.ts",
		"+++ b/src/app.ts",
		"@@ -1,2 +1,2 @@",
		"-before",
		"+after",
		" unchanged",
		"+added"
	].join("\n");

	assert.deepEqual(countPatchStats(patch), {
		additions: 2,
		deletions: 1,
		changes: 3
	});
});

unitTest("isProbablyBinary detects null bytes and suspicious control characters", () => {
	assert.equal(isProbablyBinary(Buffer.from([0x00, 0x41])), true);
	assert.equal(isProbablyBinary(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x41])), true);
	assert.equal(isProbablyBinary(Buffer.from("plain text", "utf8")), false);
});
