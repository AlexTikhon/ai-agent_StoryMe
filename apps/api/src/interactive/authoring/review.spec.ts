import { describe, expect, it } from 'vitest';
import { runAuthoring, type AuthoringResult } from './pipeline';
import { MockScenarioDraftProvider } from './provider';
import { ScriptedDraftProvider } from './scripted-provider';
import {
  buildFailureReport,
  buildReviewModel,
  buildValidationReport,
  renderReviewReport,
} from './review';
import { LAST_TRAM_BRIEF, LAST_TRAM_SCENARIO } from './the-last-tram';
import { scenarioToWire } from './wire';

async function mockResult() {
  const result = await runAuthoring({
    rawBrief: LAST_TRAM_BRIEF,
    provider: new MockScenarioDraftProvider(),
  });
  if (result.status !== 'REVIEW_REQUIRED') throw new Error('expected REVIEW_REQUIRED');
  return result;
}

describe('review model', () => {
  it('derives knowledge, disclosure, item and prerequisite evidence from the definition', () => {
    const model = buildReviewModel(LAST_TRAM_SCENARIO);
    expect(model.stats).toMatchObject({ scenes: 7, decisionPoints: 3, endings: 2, characters: 3 });

    const hanna = model.characters.find((c) => c.id === 'hanna')!;
    expect(hanna.initialFacts).toContain('f-hanna-borrowed');
    const nina = model.characters.find((c) => c.id === 'nina')!;
    expect(nina.learnedViaChoices).toContainEqual({
      choiceId: 'c-show-receipt',
      factId: 'f-hanna-borrowed',
    });

    const borrowed = model.facts.find((f) => f.id === 'f-hanna-borrowed')!;
    expect(borrowed.initiallyKnownBy).toEqual(['hanna']);
    expect(borrowed.learnedBy).toContainEqual({ choiceId: 'c-show-receipt', who: 'wiktor' });
    expect(borrowed.requiredBy).toContain('c-let-hanna-repay');

    const key = model.items.find((i) => i.id === 'service-key')!;
    expect(key.givenBy).toEqual(['c-ask-driver']);
    expect(key.consumedBy).toEqual(['c-open-panel']);

    const quiet = model.branchPrerequisites.find((b) => b.choiceId === 'c-let-hanna-repay')!;
    expect(quiet.requires[0]).toEqual({
      requirement: 'playerKnows f-hanna-borrowed',
      obtainableVia: ['c-show-receipt'],
    });
  });

  it('lists every authored narration template with its declared annotations', () => {
    const model = buildReviewModel(LAST_TRAM_SCENARIO);
    const authored = LAST_TRAM_SCENARIO.scenes.flatMap((s) => s.narration);
    expect(model.templates.map((t) => t.templateId)).toEqual(authored.map((t) => t.id));
    const cab = model.templates.find((t) => t.templateId === 't-cab-saw-hanna')!;
    expect(cab.speakerId).toBe('wiktor');
    expect(cab.factIds).toEqual(['f-driver-saw-hanna']);
  });
});

describe('human-review report', () => {
  it('states REVIEW_REQUIRED, not approved, and covers every required section', async () => {
    const result = await mockResult();
    const md = renderReviewReport(result);
    expect(md).toContain('REVIEW_REQUIRED');
    expect(md).toContain('NOT approved, NOT published');
    expect(md).toContain(result.candidateHash);
    for (const heading of [
      '## Identity and provenance',
      '## Validation results',
      '## Reachability summary',
      '## Witness routes',
      '## Character knowledge',
      '## Fact disclosures',
      '## Items and consumption',
      '## Branch prerequisites and effects',
      '## Narration templates',
      '## What this validation does NOT prove',
      '## Editorial checklist',
    ]) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('ending `report-filed`'.replace('ending', 'Ending'));
    expect(md).toContain('Ending `quiet-repayment`');
    for (const t of LAST_TRAM_SCENARIO.scenes.flatMap((s) => s.narration)) {
      expect(md).toContain(t.id);
      expect(md).toContain(t.text.replace(/\s+/g, ' '));
    }
    for (const item of [
      'unannotated secrets',
      'contradict',
      'Pacing',
      'Meaningful choices',
      'Audience',
    ]) {
      expect(md.toLowerCase()).toContain(item.toLowerCase());
    }
    expect(md).not.toMatch(/\bAPPROVED\b|safe to publish automatically/);
  });

  it('has no approve or publish status anywhere in the machine report', async () => {
    const report = buildValidationReport(await mockResult());
    expect(report).toMatchObject({
      status: 'REVIEW_REQUIRED',
      approved: false,
      editorialStatus: 'UNREVIEWED',
      publication: 'NOT_PUBLISHED',
    });
    expect(report.notProven.length).toBeGreaterThanOrEqual(4);
  });

  it('records a rejected run without any candidate content', async () => {
    const wire = structuredClone(scenarioToWire(LAST_TRAM_SCENARIO));
    wire.scenes[1]!.choices[0]!.to = 's-missing';
    const text = JSON.stringify(wire);
    const result: AuthoringResult = await runAuthoring({
      rawBrief: LAST_TRAM_BRIEF,
      provider: new ScriptedDraftProvider([{ candidate: text }, { candidate: text }]),
    });
    if (result.status !== 'REJECTED') throw new Error('expected REJECTED');
    const report = buildFailureReport(result);
    expect(report.candidateFile).toBeNull();
    expect(JSON.stringify(report)).not.toContain('Wiktor keeps one hand');
    expect(report).toMatchObject({ status: 'REJECTED', failedStage: 'definition' });
  });
});

describe('limitation: mechanical validity is not semantic approval', () => {
  it('lets an unannotated narrative contradiction through, yet the result is only REVIEW_REQUIRED', async () => {
    const wire = structuredClone(scenarioToWire(LAST_TRAM_SCENARIO));
    // t-cab-saw-hanna (annotated) has Wiktor saying he saw Hanna at the rear panel.
    // This unannotated sentence flatly contradicts it; no factIds mention it, so no check can see it.
    const intro = wire.scenes[1]!.narration.find((t) => t.id === 't-cab-intro')!;
    intro.text +=
      ' Wiktor swears he has not looked away from the rails once tonight and has seen nobody near the rear panel.';
    const result = await runAuthoring({
      rawBrief: LAST_TRAM_BRIEF,
      provider: new ScriptedDraftProvider([{ candidate: JSON.stringify(wire) }]),
    });

    // Every mechanical check passes ...
    expect(result.status).toBe('REVIEW_REQUIRED');
    if (result.status !== 'REVIEW_REQUIRED') return;
    expect(result.validation.stages.map((s) => s.passed)).toEqual(Array(6).fill(true));
    expect(result.scenario.scenes[1]!.narration[0]!.text).toContain(
      'seen nobody near the rear panel',
    );
    // ... but it is explicitly not approved, and the report tells the editor what was not proven.
    expect(result.approved).toBe(false);
    const report = buildValidationReport(result);
    expect(report.approved).toBe(false);
    expect(report.editorialStatus).toBe('UNREVIEWED');
    expect(report.notProven.join(' ')).toMatch(/contradict/i);
    const md = renderReviewReport(result);
    expect(md).toContain('NOT approved, NOT published');
    expect(md).toContain('seen nobody near the rear panel');
  });
});
