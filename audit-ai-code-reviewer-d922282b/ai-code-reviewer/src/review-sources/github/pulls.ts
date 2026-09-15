import { githubRequest } from "./client.js";
import type { PullRequestFile, PullRequestResponse } from "../types.js";

const GITHUB_PAGE_SIZE = 100;

export async function getPullRequest(
	owner: string,
	repo: string,
	pullNumber: number
): Promise<PullRequestResponse> {
	return githubRequest<PullRequestResponse>(
		`/repos/${owner}/${repo}/pulls/${pullNumber}`
	);
}

export async function getPullRequestFiles(
	owner: string,
	repo: string,
	pullNumber: number
): Promise<PullRequestFile[]> {
	const files: PullRequestFile[] = [];
	let page = 1;

	while (true) {
		const pageFiles = await githubRequest<PullRequestFile[]>(
			`/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=${GITHUB_PAGE_SIZE}&page=${page}`
		);

		files.push(...pageFiles);

		if (pageFiles.length < GITHUB_PAGE_SIZE) {
			return files;
		}

		page += 1;
	}
}
