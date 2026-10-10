import { analyzeScenario } from '../src/interactive/domain/scenario-analysis';
import { OpenAIScenarioDraftProvider } from '../src/interactive/authoring/openai-provider';
import {
  runAuthoring,
  type AuthoringResult,
  type PipelineLimits,
} from '../src/interactive/authoring/pipeline';
import { MockScenarioDraftProvider } from '../src/interactive/authoring/provider';
import {
  ScriptedDraftProvider,
  type ScriptStep,
} from '../src/interactive/authoring/scripted-provider';
import { LAST_TRAM_BRIEF, LAST_TRAM_SCENARIO } from '../src/interactive/authoring/the-last-tram';
import { validateCandidate } from '../src/interactive/authoring/validate';
import { scenarioToWire, type WireScenario } from '../src/interactive/authoring/wire';
import { listScenarioIds } from '../src/interactive/scenarios';

/**
 * Offline evaluation of the scenario-authoring workflow: fixed fixtures, an
 * in-memory scripted provider and an intercepted fetch. No PostgreSQL, Redis,
 * Nest application, API keys or network.
 *
 * It proves the deterministic validation and the call-budget behaviour on fixed
 * inputs. It says NOTHING about the quality of real model output, and a
 * REVIEW_REQUIRED outcome never means a candidate is approved.
 */

export type AuthoringEvalKind = 'valid' | 'adversarial';

export interface AuthoringEvalCase {
  id: string;
  kind: AuthoringEvalKind;
  /** Stable outcome string, e.g. "REJECTED:play-analysis" or "STOPPED:REFUSAL:generate:calls=1". */
  expected: string;
  run: () => string | Promise<string>;
}

export interface AuthoringEvalResult {
  id: string;
  kind: AuthoringEvalKind;
  expected: string;
  actual: string;
  passed: boolean;
}

// ── Fixture helpers ─────────────────────────────────────────────────────────

const baseWire = (): WireScenario => structuredClone(scenarioToWire(LAST_TRAM_SCENARIO));
const text = (w: WireScenario): string => JSON.stringify(w);
const mutated = (mutate: (w: WireScenario) => void): string => {
  const w = baseWire();
  mutate(w);
  return text(w);
};
const sceneOf = (w: WireScenario, id: string) => w.scenes.find((s) => s.id === id)!;
const choiceOf = (w: WireScenario, id: string) =>
  w.scenes.flatMap((s) => s.choices).find((c) => c.id === id)!;

const FAST: PipelineLimits = { maxOutputTokens: 4000, requestTimeoutMs: 20, deadlineMs: 5000 };

/** Content-level outcome of the validation pipeline alone. */
function validation(
  raw: unknown,
  ctx: Partial<Parameters<typeof validateCandidate>[1]> = {},
): string {
  const outcome = validateCandidate(raw, { brief: LAST_TRAM_BRIEF, ...ctx });
  return outcome.ok ? 'REVIEW_REQUIRED' : `REJECTED:${outcome.stage}`;
}

/** Stable one-line summary of a full pipeline run. */
function summary(result: AuthoringResult): string {
  switch (result.status) {
    case 'REVIEW_REQUIRED':
      return `REVIEW_REQUIRED:repaired=${result.repaired}:calls=${result.provenance.requests.length}`;
    case 'REJECTED':
      return `REJECTED:${result.stage}:repair=${result.repair}:calls=${result.provenance.requests.length}`;
    case 'STOPPED':
      return `STOPPED:${result.reason}:${result.phase}:calls=${result.provenance.requests.length}`;
    case 'BRIEF_REJECTED':
      return `BRIEF_REJECTED:${result.code}:calls=0`;
  }
}

async function scripted(steps: readonly ScriptStep[], rawBrief: unknown = LAST_TRAM_BRIEF) {
  const provider = new ScriptedDraftProvider(steps);
  const result = await runAuthoring({ rawBrief, provider, limits: FAST });
  return { result, provider };
}

async function pipelineSummary(steps: readonly ScriptStep[], rawBrief?: unknown): Promise<string> {
  return summary((await scripted(steps, rawBrief)).result);
}

/** Runs the real OpenAI adapter against an intercepted fetch and reports the fetch count. */
async function transportOutcome(fetchImpl: (init: RequestInit) => Promise<Response>) {
  let fetches = 0;
  const provider = new OpenAIScenarioDraftProvider({
    apiKey: 'sk-offline-eval-not-a-real-key',
    model: 'offline-eval-model',
    fetchImpl: ((_url: string, init: RequestInit) => {
      fetches += 1;
      return fetchImpl(init);
    }) as unknown as typeof fetch,
  });
  const result = await runAuthoring({ rawBrief: LAST_TRAM_BRIEF, provider, limits: FAST });
  return `${summary(result)}:fetches=${fetches}`;
}

const invalid = () => mutated((w) => (choiceOf(w, 'c-leave-cab').to = 's-missing'));
const valid = () => text(baseWire());

export function buildAuthoringEvalCases(): AuthoringEvalCase[] {
  return [
    // ── Valid ───────────────────────────────────────────────────────────────
    {
      id: 'valid.candidate.original-episode',
      kind: 'valid',
      expected: 'REVIEW_REQUIRED',
      run: () => validation(valid()),
    },
    {
      id: 'valid.routes.both-endings',
      kind: 'valid',
      expected: 'ENDINGS:quiet-repayment,report-filed',
      run: () => {
        const outcome = validateCandidate(valid(), { brief: LAST_TRAM_BRIEF });
        if (!outcome.ok) return `REJECTED:${outcome.stage}`;
        const routes = outcome.report.witnessRoutes;
        if (!routes.every((r) => r.stepsVerified === r.choiceIds.length + 1))
          return 'REPLAY_INCOMPLETE';
        return `ENDINGS:${routes.map((r) => r.endingId).join(',')}`;
      },
    },
    {
      id: 'valid.pipeline.mock-run',
      kind: 'valid',
      expected: 'REVIEW_REQUIRED:repaired=false:calls=1',
      run: async () =>
        summary(
          await runAuthoring({
            rawBrief: LAST_TRAM_BRIEF,
            provider: new MockScenarioDraftProvider(),
          }),
        ),
    },
    {
      id: 'valid.pipeline.mock-repeat-hash',
      kind: 'valid',
      expected: 'ACCEPTED',
      run: async () => {
        const run = () =>
          runAuthoring({ rawBrief: LAST_TRAM_BRIEF, provider: new MockScenarioDraftProvider() });
        const [a, b] = [await run(), await run()];
        return a.status === 'REVIEW_REQUIRED' &&
          b.status === 'REVIEW_REQUIRED' &&
          a.candidateHash === b.candidateHash
          ? 'ACCEPTED'
          : 'HASH_UNSTABLE';
      },
    },
    {
      id: 'valid.repair.single-repair',
      kind: 'valid',
      expected: 'REVIEW_REQUIRED:repaired=true:calls=2',
      run: () => pipelineSummary([{ candidate: invalid() }, { candidate: valid() }]),
    },
    {
      id: 'valid.registry.not-published',
      kind: 'valid',
      expected: 'ACCEPTED',
      run: () => (listScenarioIds().includes(LAST_TRAM_SCENARIO.id) ? 'REGISTERED' : 'ACCEPTED'),
    },

    // ── Adversarial: candidate format ───────────────────────────────────────
    {
      id: 'adv.format.malformed-json',
      kind: 'adversarial',
      expected: 'REJECTED:candidate-format',
      run: () => validation('{"id": "warsaw-last-tram", '),
    },
    {
      id: 'adv.format.unknown-field',
      kind: 'adversarial',
      expected: 'REJECTED:candidate-format',
      run: () =>
        validation(mutated((w) => ((w as unknown as Record<string, unknown>)['script'] = 'x'))),
    },
    {
      id: 'adv.format.unknown-effect',
      kind: 'adversarial',
      expected: 'REJECTED:candidate-format',
      run: () =>
        validation(
          mutated(
            (w) => ((choiceOf(w, 'c-ask-driver').effects[0] as { kind: string }).kind = 'teleport'),
          ),
        ),
    },
    {
      id: 'adv.format.duplicate-entry',
      kind: 'adversarial',
      expected: 'REJECTED:candidate-format',
      run: () =>
        validation(
          mutated((w) => w.initialNpcKnowledge.push({ characterId: 'hanna', factIds: [] })),
        ),
    },

    // ── Adversarial: identity ───────────────────────────────────────────────
    {
      id: 'adv.identity.changed-id',
      kind: 'adversarial',
      expected: 'REJECTED:identity',
      run: () => validation(mutated((w) => (w.id = 'warsaw-other'))),
    },
    {
      id: 'adv.identity.changed-version',
      kind: 'adversarial',
      expected: 'REJECTED:identity',
      run: () => validation(mutated((w) => (w.version = 2))),
    },
    {
      id: 'adv.identity.published-collision',
      kind: 'adversarial',
      expected: 'BRIEF_REJECTED:IDENTITY_ALREADY_PUBLISHED:calls=0',
      run: () =>
        pipelineSummary([{ candidate: valid() }], {
          ...LAST_TRAM_BRIEF,
          scenarioId: 'warsaw-last-delivery',
        }),
    },

    // ── Adversarial: existing strict definition checks ─────────────────────
    {
      id: 'adv.definition.duplicate-id',
      kind: 'adversarial',
      expected: 'REJECTED:definition',
      run: () => validation(mutated((w) => (w.scenes[1]!.id = w.scenes[0]!.id))),
    },
    {
      id: 'adv.definition.unresolved-reference',
      kind: 'adversarial',
      expected: 'REJECTED:definition',
      run: () => validation(invalid()),
    },

    // ── Adversarial: authoring constraints ──────────────────────────────────
    {
      id: 'adv.constraints.decision-points',
      kind: 'adversarial',
      expected: 'REJECTED:authoring-constraints',
      run: () =>
        validation(
          mutated((w) =>
            sceneOf(w, 's-cab').choices.push({
              id: 'c-extra',
              label: 'Linger in the cab',
              to: 's-midline',
              requires: [],
              effects: [],
            }),
          ),
        ),
    },
    {
      id: 'adv.constraints.cyclic-graph',
      kind: 'adversarial',
      expected: 'REJECTED:authoring-constraints:analysis-ran=false',
      run: () => {
        let analysisRan = false;
        const outcome = validateCandidate(
          mutated((w) =>
            sceneOf(w, 's-terminus').choices.push({
              id: 'c-ride-again',
              label: 'Ride the loop once more',
              to: 's-boarding',
              requires: [],
              effects: [],
            }),
          ),
          {
            brief: LAST_TRAM_BRIEF,
            analyze: (scenario) => {
              analysisRan = true;
              return analyzeScenario(scenario);
            },
          },
        );
        return `${outcome.ok ? 'REVIEW_REQUIRED' : `REJECTED:${outcome.stage}`}:analysis-ran=${analysisRan}`;
      },
    },

    // ── Adversarial: existing exhaustive play analysis ──────────────────────
    {
      id: 'adv.analysis.unreachable-ending',
      kind: 'adversarial',
      expected: 'REJECTED:play-analysis',
      run: () =>
        validation(
          mutated((w) =>
            choiceOf(w, 'c-let-hanna-repay').requires.push(
              { kind: 'hasItem', ref: 'service-key' },
              { kind: 'hasItem', ref: 'torn-receipt' },
            ),
          ),
        ),
    },
    {
      id: 'adv.analysis.unusable-choice',
      kind: 'adversarial',
      expected: 'REJECTED:play-analysis',
      run: () =>
        validation(
          mutated((w) =>
            choiceOf(w, 'c-wait-for-terminus').requires.push(
              { kind: 'notFlag', ref: 'asked-driver' },
              { kind: 'notFlag', ref: 'searched-carriage' },
            ),
          ),
        ),
    },
    {
      id: 'adv.analysis.dead-end',
      kind: 'adversarial',
      expected: 'REJECTED:play-analysis',
      run: () =>
        validation(
          mutated((w) => {
            choiceOf(w, 'c-show-receipt').requires.push({
              kind: 'playerKnows',
              ref: 'f-box-under-panel',
            });
            choiceOf(w, 'c-wait-for-terminus').requires.push({
              kind: 'notFlag',
              ref: 'searched-carriage',
            });
          }),
        ),
    },
    {
      id: 'adv.analysis.speaker-knowledge',
      kind: 'adversarial',
      expected: 'REJECTED:play-analysis',
      run: () =>
        validation(
          mutated(
            (w) =>
              (sceneOf(w, 's-cab').narration.find((t) => t.id === 't-cab-saw-hanna')!.speakerId =
                'hanna'),
          ),
        ),
    },

    // ── Adversarial: canonical narration along real routes ─────────────────
    {
      id: 'adv.witness.oversized-narration',
      kind: 'adversarial',
      expected: 'REJECTED:witness-routes',
      run: () =>
        validation(
          mutated((w) => {
            sceneOf(w, 's-boarding').narration = Array.from({ length: 5 }, (_, i) => ({
              id: `t-long-${i}`,
              text: 'a'.repeat(600),
              speakerId: null,
              factIds: [],
              when: [],
            }));
          }),
        ),
    },

    // ── Adversarial: bounded repair ─────────────────────────────────────────
    {
      id: 'adv.repair.still-invalid',
      kind: 'adversarial',
      expected: 'REJECTED:definition:repair=attempted:calls=2',
      run: () =>
        pipelineSummary([
          { candidate: invalid() },
          { candidate: invalid() },
          { candidate: valid() },
        ]),
    },

    // ── Adversarial: provider failures stop the run, never trigger repair ──
    {
      id: 'adv.provider.refusal',
      kind: 'adversarial',
      expected: 'STOPPED:REFUSAL:generate:calls=1',
      run: () => pipelineSummary([{ fail: 'refusal' }, { candidate: valid() }]),
    },
    {
      id: 'adv.provider.truncated',
      kind: 'adversarial',
      expected: 'STOPPED:TRUNCATED:generate:calls=1',
      run: () => pipelineSummary([{ fail: 'truncated' }, { candidate: valid() }]),
    },
    {
      id: 'adv.provider.authentication',
      kind: 'adversarial',
      expected: 'STOPPED:AUTHENTICATION:generate:calls=1',
      run: () => pipelineSummary([{ fail: 'authentication' }, { candidate: valid() }]),
    },
    {
      id: 'adv.provider.timeout',
      kind: 'adversarial',
      expected: 'STOPPED:TIMEOUT:generate:calls=1',
      run: () => pipelineSummary([{ fail: 'timeout' }, { candidate: valid() }]),
    },
    {
      id: 'adv.provider.network',
      kind: 'adversarial',
      expected: 'STOPPED:NETWORK:generate:calls=1',
      run: () => pipelineSummary([{ fail: 'network' }, { candidate: valid() }]),
    },
    {
      id: 'adv.provider.cancellation',
      kind: 'adversarial',
      expected: 'STOPPED:CANCELLED:generate:calls=1',
      run: async () => {
        const controller = new AbortController();
        const provider = new ScriptedDraftProvider([{ hang: true }, { candidate: valid() }]);
        const pending = runAuthoring({
          rawBrief: LAST_TRAM_BRIEF,
          provider,
          limits: FAST,
          signal: controller.signal,
        });
        setTimeout(() => controller.abort(), 10);
        return summary(await pending);
      },
    },

    // ── Adversarial: call budget and disabled implicit retries ─────────────
    {
      id: 'adv.budget.exhausted',
      kind: 'adversarial',
      expected: 'REJECTED:definition:repair=skipped_budget_exhausted:calls=1',
      run: () =>
        pipelineSummary([{ candidate: invalid(), httpAttempts: 2 }, { candidate: valid() }]),
    },
    {
      id: 'adv.budget.provider-overrun',
      kind: 'adversarial',
      expected: 'STOPPED:CALL_BUDGET_EXCEEDED:generate:calls=1',
      run: () => pipelineSummary([{ candidate: valid(), httpAttempts: 3 }]),
    },
    {
      id: 'adv.transport.no-http-retry',
      kind: 'adversarial',
      expected: 'STOPPED:PROVIDER_ERROR:generate:calls=1:fetches=1',
      run: () => transportOutcome(async () => new Response('unavailable', { status: 503 })),
    },
    {
      id: 'adv.transport.no-network-retry',
      kind: 'adversarial',
      expected: 'STOPPED:NETWORK:generate:calls=1:fetches=1',
      run: () =>
        transportOutcome(async () => {
          throw new TypeError('connection reset');
        }),
    },
    {
      id: 'adv.transport.no-timeout-retry',
      kind: 'adversarial',
      expected: 'STOPPED:TIMEOUT:generate:calls=1:fetches=1',
      run: () =>
        transportOutcome(
          (init) =>
            new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
              });
            }),
        ),
    },

    // ── Adversarial: mechanical validity is not editorial approval ─────────
    {
      id: 'adv.review.mechanical-not-approved',
      kind: 'adversarial',
      expected: 'REVIEW_REQUIRED:approved=false',
      run: async () => {
        // An unannotated sentence contradicting the annotated cab testimony: nothing can detect it.
        const contradiction = mutated((w) => {
          sceneOf(w, 's-cab').narration.find((t) => t.id === 't-cab-intro')!.text +=
            ' Wiktor swears he has seen nobody near the rear panel all night.';
        });
        const { result } = await scripted([{ candidate: contradiction }]);
        return result.status === 'REVIEW_REQUIRED'
          ? `REVIEW_REQUIRED:approved=${result.approved}`
          : summary(result);
      },
    },
  ];
}

export async function evaluateAuthoringCases(
  cases: readonly AuthoringEvalCase[],
): Promise<AuthoringEvalResult[]> {
  const results: AuthoringEvalResult[] = [];
  for (const c of cases) {
    let actual: string;
    try {
      actual = await c.run();
    } catch (error) {
      actual = `UNEXPECTED:${error instanceof Error ? error.name : 'unknown'}`;
    }
    results.push({
      id: c.id,
      kind: c.kind,
      expected: c.expected,
      actual,
      passed: actual === c.expected,
    });
  }
  return results;
}

export function runAuthoringOfflineEvaluation(): Promise<AuthoringEvalResult[]> {
  return evaluateAuthoringCases(buildAuthoringEvalCases());
}

/** Nonzero when any case produced an unexpected outcome (or no case ran at all). */
export function exitCodeFor(results: readonly AuthoringEvalResult[]): number {
  return results.length > 0 && results.every((r) => r.passed) ? 0 : 1;
}

async function main(): Promise<void> {
  const results = await runAuthoringOfflineEvaluation();
  const failed = results.filter((r) => !r.passed);
  const count = (kind: AuthoringEvalKind) => results.filter((r) => r.kind === kind).length;
  console.log('Interactive scenario authoring offline evaluation');
  console.log('');
  console.log(
    `Candidate under test: ${LAST_TRAM_SCENARIO.id}@${LAST_TRAM_SCENARIO.version} (mock, unpublished)`,
  );
  console.log(
    `Cases: ${results.length} (valid ${count('valid')}, adversarial ${count('adversarial')})`,
  );
  console.log(`Passed: ${results.length - failed.length}`);
  console.log(`Failed: ${failed.length}`);
  console.log('Services required: none');
  console.log('External API calls: 0');
  console.log('API keys required: 0');
  console.log(
    'Note: proves deterministic validation and call limits only; not real-model quality.',
  );
  console.log('');
  for (const result of results) {
    const detail = result.passed ? '' : ` [expected ${result.expected}, got ${result.actual}]`;
    console.log(
      `${result.passed ? 'PASS' : 'FAIL'} ${result.kind.padEnd(11)} ${result.id} -> ${result.expected}${detail}`,
    );
  }
  process.exitCode = exitCodeFor(results);
}

if (require.main === module) void main();
