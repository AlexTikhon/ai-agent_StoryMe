import {
  fetchWithRetry,
  OpenAIRequestError,
  OpenAIResponseBodyError,
  readOpenAITextUsage,
} from '../../common/openai-request';
import { isProviderCancellationError } from '../../common/provider-execution';
import { assertStructuredCompletion, StructuredOutputError } from '../../common/structured-output';
import { MAX_HTTP_BODY_CHARS } from './limits';
import {
  DraftProviderError,
  type DraftRequest,
  type DraftResponse,
  type DraftUsage,
  type ScenarioDraftProvider,
} from './provider';
import { buildUserMessage, SYSTEM_PROMPT } from './prompts';
import { WIRE_RESPONSE_FORMAT } from './wire';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface OpenAIScenarioDraftProviderOptions {
  apiKey: string;
  /** Required and explicit: there is deliberately no default model. */
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

class BodyTooLargeError extends Error {}

async function readBoundedText(response: Response, maxChars: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > maxChars) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError();
      }
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}

/**
 * Independent OpenAI adapter for scenario drafting. It shares only the
 * low-level transport helper with the book pipeline and is configured
 * separately (explicit model, own limits). One call = one HTTP attempt:
 * implicit network, timeout and HTTP-status retries are all disabled so
 * transport retries can never multiply the pipeline's call budget.
 *
 * It never sends tools, files or browsing, never reads provider error bodies,
 * and never logs anything (credentials, briefs and raw output stay out of logs).
 */
export class OpenAIScenarioDraftProvider implements ScenarioDraftProvider {
  readonly name = 'openai' as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIScenarioDraftProviderOptions) {
    if (!options.apiKey) throw new Error('OpenAIScenarioDraftProvider requires an apiKey');
    if (!MODEL_PATTERN.test(options.model ?? '')) {
      throw new Error('OpenAIScenarioDraftProvider requires an explicit, well-formed model name');
    }
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async draft(request: DraftRequest): Promise<DraftResponse> {
    let attempts = 0;
    let result;
    try {
      result = await fetchWithRetry<unknown>({
        fetchImpl: this.fetchImpl,
        url: `${this.baseUrl}/chat/completions`,
        init: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: buildUserMessage(request) },
            ],
            response_format: WIRE_RESPONSE_FORMAT,
            max_completion_tokens: request.maxOutputTokens,
          }),
        },
        timeoutMs: request.timeoutMs,
        // No implicit retries of any kind: the pipeline owns the whole call budget.
        maxRetries: 0,
        timeoutMaxRetries: 0,
        signal: request.signal,
        onAttempt: () => {
          attempts += 1;
        },
        consumeResponse: async (response) => {
          if (!response.ok) {
            // The error body is never read, stored or logged.
            await response.body?.cancel().catch(() => undefined);
            return undefined;
          }
          return JSON.parse(await readBoundedText(response, MAX_HTTP_BODY_CHARS)) as unknown;
        },
      });
    } catch (error) {
      if (isProviderCancellationError(error)) throw new DraftProviderError('cancelled', attempts);
      if (error instanceof OpenAIRequestError) {
        throw new DraftProviderError(error.reason === 'timeout' ? 'timeout' : 'network', attempts);
      }
      if (error instanceof OpenAIResponseBodyError) {
        throw new DraftProviderError('invalid_response', attempts);
      }
      throw new DraftProviderError('provider_error', attempts);
    }

    if (!result.ok) {
      const kind =
        result.status === 401 || result.status === 403
          ? 'authentication'
          : result.status === 429
            ? 'rate_limit'
            : 'provider_error';
      throw new DraftProviderError(kind, attempts);
    }

    const payload = result.body;
    const metrics = readOpenAITextUsage(payload);
    const usage: DraftUsage = {
      ...(metrics.inputTokens !== undefined && { inputTokens: metrics.inputTokens }),
      ...(metrics.outputTokens !== undefined && { outputTokens: metrics.outputTokens }),
    };

    try {
      assertStructuredCompletion(payload);
    } catch (error) {
      if (error instanceof StructuredOutputError) {
        throw new DraftProviderError(
          error.failureKind === 'truncated' ? 'truncated' : 'refusal',
          attempts,
          usage,
        );
      }
      throw new DraftProviderError('invalid_response', attempts, usage);
    }

    const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> } | null)
      ?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new DraftProviderError('invalid_response', attempts, usage);
    }
    return { candidate: content, usage, httpAttempts: attempts };
  }
}
