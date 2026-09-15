const GITHUB_API_BASE = "https://api.github.com";

type RequestOptions = {
	method?: "GET" | "POST";
	body?: unknown;
};

export async function githubRequest<T>(
	path: string,
	options: RequestOptions = {}
): Promise<T> {
	const token = process.env.GITHUB_TOKEN;

	if (!token) {
		throw new Error("Missing GITHUB_TOKEN");
	}

	const response = await fetch(`${GITHUB_API_BASE}${path}`, {
		method: options.method ?? "GET",
		headers: {
			"Accept": "application/vnd.github+json",
			"Authorization": `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
			"Content-Type": "application/json"
		},
		body: options.body ? JSON.stringify(options.body) : undefined
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`GitHub API error ${response.status}: ${text}`);
	}

	return response.json() as Promise<T>;
}
