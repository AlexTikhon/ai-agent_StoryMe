import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './cli-config';

const SECRET = 'sk-live-do-not-leak-0000';
const parse = (argv: string[], env: NodeJS.ProcessEnv = {}) => parseCliArgs(argv, env);
const errorOf = (argv: string[], env: NodeJS.ProcessEnv = {}) => {
  const r = parse(argv, env);
  return r.ok ? null : r.error;
};

describe('parseCliArgs', () => {
  it('runs mock mode with no keys and the built-in brief by default', () => {
    const r = parse(['--mode', 'mock']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config).toMatchObject({
      mode: 'mock',
      briefSource: { kind: 'builtin', name: 'the-last-tram' },
      model: null,
      apiKey: null,
    });
    expect(r.config.limits).toEqual({
      maxOutputTokens: 8000,
      requestTimeoutMs: 120_000,
      deadlineMs: 300_000,
    });
  });

  it('requires an explicit mode', () => {
    expect(errorOf([])).toContain('--mode');
    expect(errorOf(['--mode', 'auto'])).toContain('--mode');
  });

  it('never selects the paid provider because an API key exists', () => {
    expect(errorOf([], { OPENAI_API_KEY: SECRET })).toContain('--mode');
    const mockWithKey = parse(['--mode', 'mock'], {
      OPENAI_API_KEY: SECRET,
      INTERACTIVE_AUTHORING_MODEL: 'm',
    });
    expect(mockWithKey.ok && mockWithKey.config.mode === 'mock' && mockWithKey.config.apiKey).toBe(
      null,
    );
  });

  it('requires the explicit paid-call opt-in, a configured model, a key and an explicit brief', () => {
    const env = { OPENAI_API_KEY: SECRET };
    const base = ['--mode', 'openai', '--brief', 'the-last-tram'];
    expect(errorOf([...base, '--model', 'gpt-test'], env)).toContain('--allow-paid-calls');
    expect(errorOf([...base, '--allow-paid-calls'], env)).toContain('--model');
    expect(errorOf([...base, '--allow-paid-calls', '--model', 'gpt-test'], {})).toContain(
      'OPENAI_API_KEY',
    );
    expect(
      errorOf(['--mode', 'openai', '--allow-paid-calls', '--model', 'gpt-test'], env),
    ).toContain('--brief');
    const ok = parse([...base, '--allow-paid-calls', '--model', 'gpt-test'], env);
    expect(ok.ok && ok.config.model).toBe('gpt-test');
    const envModel = parse([...base, '--allow-paid-calls'], {
      ...env,
      INTERACTIVE_AUTHORING_MODEL: 'env-model',
    });
    expect(envModel.ok && envModel.config.model).toBe('env-model');
  });

  it('rejects the paid flag in mock mode', () => {
    expect(errorOf(['--mode', 'mock', '--allow-paid-calls'])).toContain('openai');
  });

  it('never echoes the API key in an error', () => {
    for (const argv of [
      ['--mode', 'openai', '--allow-paid-calls'],
      [
        '--mode',
        'openai',
        '--allow-paid-calls',
        '--model',
        'bad model',
        '--brief',
        'the-last-tram',
      ],
      ['--mode', 'openai', `--api-key=${SECRET}`],
    ]) {
      expect(errorOf(argv, { OPENAI_API_KEY: SECRET }) ?? '').not.toContain(SECRET);
    }
  });

  it('rejects malformed or out-of-range limits instead of clamping them', () => {
    expect(errorOf(['--mode', 'mock', '--max-output-tokens', '99999999'])).toContain('between');
    expect(errorOf(['--mode', 'mock', '--max-output-tokens', 'lots'])).toContain('integer');
    expect(errorOf(['--mode', 'mock', '--deadline-ms', '1'])).toContain('between');
    expect(errorOf(['--mode', 'mock', '--request-timeout-ms=999999999'])).toContain('between');
    const ok = parse(['--mode', 'mock'], { INTERACTIVE_AUTHORING_MAX_OUTPUT_TOKENS: '3000' });
    expect(ok.ok && ok.config.limits.maxOutputTokens).toBe(3000);
  });

  it('rejects unknown, duplicate and positional arguments and conflicting brief sources', () => {
    expect(errorOf(['--mode', 'mock', '--tools', 'on'])).toContain('unknown flag');
    expect(errorOf(['--mode', 'mock', '--mode', 'mock'])).toContain('duplicate');
    expect(errorOf(['mock'])).toContain('positional');
    expect(
      errorOf(['--mode', 'mock', '--brief', 'the-last-tram', '--brief-file', 'b.json']),
    ).toContain('not both');
    expect(errorOf(['--mode', 'mock', '--brief', 'unknown-brief'])).toContain('built-in');
    expect(errorOf(['--mode'])).toContain('requires a value');
  });
});
