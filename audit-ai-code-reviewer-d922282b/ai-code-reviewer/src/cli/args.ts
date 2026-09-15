export type CliArgs =
	| {
			reviewMode: "pr";
			owner: string;
			repo: string;
			pullNumber: number;
	  }
	| {
			reviewMode: "local";
			localBaseRef?: string;
			localRepoPath?: string;
	  };

export function parseArgs(argv: string[]): CliArgs {
	if (argv.includes("--local")) {
		const baseIndex = argv.indexOf("--base");
		const repoIndex = argv.indexOf("--repo");
		const localBaseRef = baseIndex >= 0 ? argv[baseIndex + 1] : undefined;
		const localRepoPath = repoIndex >= 0 ? argv[repoIndex + 1] : undefined;

		if (baseIndex >= 0 && !localBaseRef) {
			throw new Error("--base requires a ref value");
		}

		if (repoIndex >= 0 && !localRepoPath) {
			throw new Error("--repo requires a path value");
		}

		return {
			reviewMode: "local",
			localBaseRef,
			localRepoPath
		};
	}

	const [owner, repo, pullNumberRaw] = argv;

	if (!owner || !repo || !pullNumberRaw) {
		throw new Error("Missing required PR arguments");
	}

	const pullNumber = Number(pullNumberRaw);

	if (Number.isNaN(pullNumber)) {
		throw new Error("pullNumber must be a number");
	}

	return {
		reviewMode: "pr",
		owner,
		repo,
		pullNumber
	};
}
