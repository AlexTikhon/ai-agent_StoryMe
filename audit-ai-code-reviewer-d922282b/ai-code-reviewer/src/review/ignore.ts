import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type IgnoreRule = {
	pattern: string;
	negated: boolean;
};

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function compileGlob(pattern: string): RegExp {
	let regex = "";

	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		const nextChar = pattern[index + 1];

		if (char === "*") {
			if (nextChar === "*") {
				regex += ".*";
				index += 1;
				continue;
			}

			regex += "[^/]*";
			continue;
		}

		if (char === "?") {
			regex += "[^/]";
			continue;
		}

		regex += escapeRegex(char);
	}

	return new RegExp(`^${regex}$`);
}

function normalizePattern(rawPattern: string): {
	matcher: RegExp;
	matchBasename: boolean;
	directoryOnly: boolean;
	anchoredToRoot: boolean;
} {
	const directoryOnly = rawPattern.endsWith("/");
	const anchoredToRoot = rawPattern.startsWith("/");
	const withoutPrefix = anchoredToRoot ? rawPattern.slice(1) : rawPattern;
	const normalized = withoutPrefix.replaceAll("\\", "/").replace(/\/+$/, "");
	const matchBasename = !normalized.includes("/");
	const sourcePattern =
		directoryOnly && normalized ? `${normalized}/**` : normalized;

	return {
		matcher: compileGlob(sourcePattern),
		matchBasename,
		directoryOnly,
		anchoredToRoot
	};
}

export function parseIgnoreFile(contents: string): IgnoreRule[] {
	return contents
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"))
		.map((line) => ({
			negated: line.startsWith("!"),
			pattern: line.startsWith("!") ? line.slice(1) : line
		}))
		.filter((rule) => rule.pattern);
}

export async function loadIgnoreRules(basePath: string): Promise<IgnoreRule[]> {
	try {
		const contents = await readFile(
			resolve(basePath, ".ai-reviewer-ignore"),
			"utf8"
		);
		return parseIgnoreFile(contents);
	} catch {
		return [];
	}
}

export function isIgnoredPath(filename: string, rules: IgnoreRule[]): boolean {
	if (!rules.length) {
		return false;
	}

	const normalizedPath = filename.replaceAll("\\", "/").replace(/^\/+/, "");
	const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
	let ignored = false;

	for (const rule of rules) {
		const { matcher, matchBasename, directoryOnly, anchoredToRoot } =
			normalizePattern(rule.pattern);
		const candidate = matchBasename ? basename : normalizedPath;
		const matches =
			matcher.test(candidate) ||
			(!anchoredToRoot && !matchBasename && matcher.test(`/${normalizedPath}`.slice(1))) ||
			(directoryOnly &&
				(normalizedPath === rule.pattern.replace(/\/+$/, "") ||
					normalizedPath.startsWith(`${rule.pattern.replace(/\/+$/, "")}/`)));

		if (matches) {
			ignored = !rule.negated;
		}
	}

	return ignored;
}
