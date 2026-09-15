import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { PullRequestFile } from "../types.js";

const execFileAsync = promisify(execFile);

type LocalDiffResult = {
	title: string;
	body: string;
	baseRef: string;
	headRef: string;
	files: PullRequestFile[];
};

type NameStatusEntry = {
	status: string;
	filename: string;
	previousFilename?: string;
};

async function runGit(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		maxBuffer: 10 * 1024 * 1024
	});
	return stdout;
}

export function parseNameStatus(output: string): NameStatusEntry[] {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const parts = line.split("\t");
			const status = parts[0] ?? "";

			if (status.startsWith("R")) {
				return {
					status: "renamed",
					previousFilename: parts[1],
					filename: parts[2] ?? parts[1] ?? ""
				};
			}

			const statusMap: Record<string, string> = {
				A: "added",
				M: "modified",
				D: "removed",
				T: "changed"
			};

			return {
				status: statusMap[status[0] ?? ""] ?? "modified",
				filename: parts[1] ?? ""
			};
		})
		.filter((entry) => entry.filename);
}

export function countLines(value: string): number {
	if (!value) {
		return 0;
	}

	return value.split(/\r?\n/).length;
}

export function countPatchStats(patch: string): {
	additions: number;
	deletions: number;
	changes: number;
} {
	let additions = 0;
	let deletions = 0;

	for (const line of patch.split("\n")) {
		if (line.startsWith("+++ ") || line.startsWith("--- ")) {
			continue;
		}

		if (line.startsWith("+")) {
			additions += 1;
			continue;
		}

		if (line.startsWith("-")) {
			deletions += 1;
		}
	}

	return {
		additions,
		deletions,
		changes: additions + deletions
	};
}

export function isProbablyBinary(buffer: Buffer): boolean {
	if (!buffer.length) {
		return false;
	}

	let suspiciousBytes = 0;

	for (const byte of buffer) {
		if (byte === 0) {
			return true;
		}

		const isControl =
			byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12;
		if (isControl) {
			suspiciousBytes += 1;
		}
	}

	return suspiciousBytes / buffer.length > 0.1;
}

async function buildUntrackedFilePatch(
	repoPath: string,
	filename: string
): Promise<PullRequestFile> {
	try {
		const buffer = await readFile(resolve(repoPath, filename));

		if (isProbablyBinary(buffer)) {
			return {
				filename,
				status: "added",
				additions: 0,
				deletions: 0,
				changes: 0
			};
		}

		const contents = buffer.toString("utf8");
		const normalized = contents.replace(/\r\n/g, "\n");
		const lines = normalized.split("\n");
		const patchLines = [
			`diff --git a/${filename} b/${filename}`,
			"new file mode 100644",
			"--- /dev/null",
			`+++ b/${filename}`,
			`@@ -0,0 +1,${countLines(normalized)} @@`,
			...lines.map((line) => `+${line}`)
		];

		return {
			filename,
			status: "added",
			additions: countLines(normalized),
			deletions: 0,
			changes: countLines(normalized),
			patch: patchLines.join("\n")
		};
	} catch {
		return {
			filename,
			status: "added",
			additions: 0,
			deletions: 0,
			changes: 0
		};
	}
}

async function getTrackedDiffFiles(
	repoPath: string,
	compareRef: string
): Promise<PullRequestFile[]> {
	const nameStatusOutput = await runGit(
		[
			"diff",
			"--name-status",
			"--find-renames",
			compareRef
		],
		repoPath
	);
	const entries = parseNameStatus(nameStatusOutput);

	const files = await Promise.all(
		entries.map(async (entry) => {
			const patch = await runGit(
				[
					"diff",
					"--no-color",
					"--find-renames",
					compareRef,
					"--",
					entry.filename
				],
				repoPath
			);
			const stats = countPatchStats(patch);

			return {
				filename: entry.filename,
				status: entry.status,
				additions: stats.additions,
				deletions: stats.deletions,
				changes: stats.changes,
				patch: patch || undefined
			} satisfies PullRequestFile;
		})
	);

	return files;
}

async function getUntrackedFiles(repoPath: string): Promise<PullRequestFile[]> {
	const output = await runGit(
		["ls-files", "--others", "--exclude-standard"],
		repoPath
	);
	const files = output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	return Promise.all(
		files.map((filename) => buildUntrackedFilePatch(repoPath, filename))
	);
}

async function resolveBaseRef(repoPath: string, baseRef?: string): Promise<string> {
	if (!baseRef) {
		return "HEAD";
	}

	const mergeBase = (
		await runGit(["merge-base", baseRef, "HEAD"], repoPath)
	).trim();

	if (!mergeBase) {
		throw new Error(`Could not resolve merge-base for ${baseRef}`);
	}

	return mergeBase;
}

export async function getLocalDiff(
	baseRef?: string,
	repoPath = process.cwd()
): Promise<LocalDiffResult> {
	const resolvedRepoPath = resolve(repoPath);
	const resolvedBaseRef = await resolveBaseRef(resolvedRepoPath, baseRef);
	const [headRef, branchName, trackedFiles, untrackedFiles] = await Promise.all([
		runGit(["rev-parse", "--short", "HEAD"], resolvedRepoPath),
		runGit(["rev-parse", "--abbrev-ref", "HEAD"], resolvedRepoPath),
		getTrackedDiffFiles(resolvedRepoPath, resolvedBaseRef),
		getUntrackedFiles(resolvedRepoPath)
	]);

	const title = baseRef
		? `Local diff review against ${baseRef}`
		: "Local diff review against HEAD";
	const body = baseRef
		? `Reviewing working tree changes relative to merge-base(${baseRef}, HEAD).`
		: "Reviewing tracked and untracked local changes relative to HEAD.";

	return {
		title,
		body,
		baseRef: baseRef ?? "HEAD",
		headRef: headRef.trim() || branchName.trim(),
		files: [...trackedFiles, ...untrackedFiles]
	};
}
