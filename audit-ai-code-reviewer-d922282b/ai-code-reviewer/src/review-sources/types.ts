export type PullRequestResponse = {
	number: number;
	title: string;
	body: string | null;
	base: { ref: string };
	head: { ref: string };
};

export type PullRequestFile = {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	changes: number;
	patch?: string;
};
