const MAX_PATCH_LENGTH = 15000;

export function splitPatchIntoSections(patch: string): {
	preamble: string;
	hunks: string[];
} {
	const lines = patch.split("\n");
	const preambleLines: string[] = [];
	const hunks: string[] = [];
	let currentHunk: string[] | undefined;

	for (const line of lines) {
		if (line.startsWith("@@")) {
			if (currentHunk) {
				hunks.push(currentHunk.join("\n"));
			}
			currentHunk = [line];
			continue;
		}

		if (currentHunk) {
			currentHunk.push(line);
			continue;
		}

		preambleLines.push(line);
	}

	if (currentHunk) {
		hunks.push(currentHunk.join("\n"));
	}

	return {
		preamble: preambleLines.join("\n"),
		hunks
	};
}

export function getMaxPatchLength(): number {
	return MAX_PATCH_LENGTH;
}

export function truncatePatch(patch: string): string {
	const { preamble, hunks } = splitPatchIntoSections(patch);

	if (!hunks.length) {
		return `${patch.slice(
			0,
			MAX_PATCH_LENGTH
		)}\n\n[TRUNCATED: patch exceeded review size limit and had no detectable hunks]`;
	}

	const sections: string[] = preamble ? [preamble] : [];
	let currentLength = preamble.length;
	let keptHunks = 0;

	for (const hunk of hunks) {
		const separatorLength = sections.length ? 1 : 0;
		const nextLength = currentLength + separatorLength + hunk.length;

		if (keptHunks > 0 && nextLength > MAX_PATCH_LENGTH) {
			break;
		}

		sections.push(hunk);
		currentLength = nextLength;
		keptHunks += 1;

		if (keptHunks === 1 && currentLength > MAX_PATCH_LENGTH) {
			break;
		}
	}

	return `${sections.join("\n")}\n\n[TRUNCATED: kept ${keptHunks}/${hunks.length} complete hunk(s) within review size limit]`;
}
