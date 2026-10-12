import { describe, expect, it } from 'vitest';
import { parseExperimentArgs, type ExperimentConfig } from './experiment-config';

const SECRET = 'sk-test-experiment-secret-0123456789';

const parse = (argv: string[], env: NodeJS.ProcessEnv = {}) => parseExperimentArgs(argv, env);
const errorOf = (argv: string[], env: NodeJS.ProcessEnv = {}): string | undefined => {
  const parsed = parse(argv, env);
  return parsed.ok ? undefined : parsed.error;
};
const configOf = (argv: string[], env: NodeJS.ProcessEnv = {}): ExperimentConfig => {
  const parsed = parse(argv, env);
  if (!parsed.ok) throw new Error(`unexpected parse failure: ${parsed.error}`);
  return parsed.config;
};

describe('parseExperimentArgs', () => {
  it('defaults to the plan mode with no model, key or paid gate', () => {
    const config = configOf([]);
    expect(config.mode).toBe('plan');
    expect(config.model).toBeNull();
    expect(config.apiKey).toBeNull();
    expect(config.draftsRoot).toBeUndefined();
  });

  it('never reads the API key in plan or offline mode, even when one is present', () => {
    const env = { OPENAI_API_KEY: SECRET };
    expect(configOf([], env).apiKey).toBeNull();
    expect(configOf(['--mode', 'plan'], env).apiKey).toBeNull();
    expect(configOf(['--mode', 'offline'], env).apiKey).toBeNull();
  });

  it('does not let an API key in the environment select or enable the paid mode', () => {
    const env = { OPENAI_API_KEY: SECRET, INTERACTIVE_AUTHORING_MODEL: 'some-model' };
    expect(configOf([], env).mode).toBe('plan');
    expect(errorOf(['--mode', 'openai'], env)).toContain('--allow-paid-calls');
  });

  it('requires the explicit mode, the paid flag, an explicit model and a key for openai', () => {
    const env = { OPENAI_API_KEY: SECRET };
    expect(errorOf(['--allow-paid-calls', '--model', 'm1'], env)).toContain('openai');
    expect(errorOf(['--mode', 'openai', '--model', 'm1'], env)).toContain('--allow-paid-calls');
    expect(errorOf(['--mode', 'openai', '--allow-paid-calls'], env)).toContain('--model');
    expect(errorOf(['--mode', 'openai', '--allow-paid-calls', '--model', 'm1'])).toContain(
      'OPENAI_API_KEY',
    );
    expect(
      errorOf(['--mode', 'openai', '--allow-paid-calls', '--model', 'm1'], {
        OPENAI_API_KEY: '  ',
      }),
    ).toContain('OPENAI_API_KEY');

    const config = configOf(['--mode', 'openai', '--allow-paid-calls', '--model', 'm1'], env);
    expect(config).toMatchObject({ mode: 'openai', model: 'm1', apiKey: SECRET });
  });

  it('accepts the model from INTERACTIVE_AUTHORING_MODEL like the single-brief CLI', () => {
    const config = configOf(['--mode', 'openai', '--allow-paid-calls'], {
      OPENAI_API_KEY: SECRET,
      INTERACTIVE_AUTHORING_MODEL: 'env-model',
    });
    expect(config.model).toBe('env-model');
  });

  it('rejects malformed model names', () => {
    expect(
      errorOf(['--mode', 'openai', '--allow-paid-calls', '--model', 'bad model'], {
        OPENAI_API_KEY: SECRET,
      }),
    ).toContain('--model');
    expect(errorOf(['--model', '-x'])).toContain('--model');
  });

  it('lets the plan name a model, but never a paid gate', () => {
    expect(configOf(['--model', 'm1']).model).toBe('m1');
    expect(errorOf(['--mode', 'plan', '--allow-paid-calls'])).toContain('--mode openai');
    expect(errorOf(['--mode', 'offline', '--allow-paid-calls'])).toContain('--mode openai');
  });

  it('refuses a model in offline mode: scripted fixtures have no model', () => {
    expect(errorOf(['--mode', 'offline', '--model', 'm1'])).toContain('offline');
  });

  it('shares the limit flags and env names with the single-brief CLI, rejecting rather than clamping', () => {
    expect(errorOf(['--max-output-tokens', '99999999'])).toContain('between');
    expect(errorOf(['--max-output-tokens', 'lots'])).toContain('integer');
    expect(errorOf(['--deadline-ms', '1'])).toContain('between');
    expect(errorOf(['--request-timeout-ms=999999999'])).toContain('between');
    const config = configOf([], { INTERACTIVE_AUTHORING_MAX_OUTPUT_TOKENS: '3000' });
    expect(config.limits.maxOutputTokens).toBe(3000);
  });

  it('rejects unknown, duplicate, positional and brief-selecting arguments', () => {
    expect(errorOf(['--mode', 'bogus'])).toContain('--mode');
    expect(errorOf(['--mode', 'plan', '--mode', 'plan'])).toContain('duplicate');
    expect(errorOf(['plan'])).toContain('positional');
    expect(errorOf(['--tools', 'on'])).toContain('unknown flag');
    // The corpus is fixed: there is deliberately no way to choose another brief.
    expect(errorOf(['--brief', 'the-last-tram'])).toContain('unknown flag');
    expect(errorOf(['--brief-file', 'b.json'])).toContain('unknown flag');
    expect(errorOf(['--mode'])).toContain('requires a value');
  });

  it('never echoes the API key in an error', () => {
    for (const argv of [
      ['--mode', 'openai', '--allow-paid-calls'],
      ['--mode', 'openai', '--model', 'm1'],
      ['--mode', 'openai', '--allow-paid-calls', '--model', 'bad model'],
      ['--mode', 'openai', `--api-key=${SECRET}`],
    ]) {
      expect(errorOf(argv, { OPENAI_API_KEY: SECRET }) ?? '').not.toContain(SECRET);
    }
  });
});
