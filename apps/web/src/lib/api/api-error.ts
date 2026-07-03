export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Extracts a human-readable message from a failed API response body. */
export async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string | string[] };
    if (body.message) {
      return Array.isArray(body.message) ? body.message.join(', ') : String(body.message);
    }
  } catch {
    // ignore parse error
  }
  return `HTTP ${res.status}`;
}
