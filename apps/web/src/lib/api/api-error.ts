export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Machine-readable error code (e.g. "EMAIL_NOT_VERIFIED", "RATE_LIMITED"), when the API sent one. */
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Extracts a human-readable message from a failed API response body. */
export async function parseErrorMessage(res: Response): Promise<string> {
  return (await parseApiError(res)).message;
}

/** Extracts both the human-readable message and machine-readable code (if any) from a failed API response body. */
export async function parseApiError(res: Response): Promise<{ message: string; code?: string }> {
  try {
    const body = (await res.json()) as { message?: string | string[]; code?: string };
    const message = body.message
      ? Array.isArray(body.message)
        ? body.message.join(', ')
        : String(body.message)
      : `HTTP ${res.status}`;
    return body.code ? { message, code: body.code } : { message };
  } catch {
    return { message: `HTTP ${res.status}` };
  }
}
