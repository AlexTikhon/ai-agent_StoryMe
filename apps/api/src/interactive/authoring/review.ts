import type { Effect, Requirement, ScenarioDefinition } from '../domain/scenario-schema';
import { countDecisionPoints } from './validate';
import type { AuthoringResult } from './pipeline';

/**
 * Evidence for the human editor. Everything here is derived mechanically from
 * the validated definition; it organizes what the author DECLARED. It cannot
 * show that free prose agrees with those declarations.
 */

export const NOT_PROVEN = [
  'Prose may contradict itself or other scenes without any factIds annotation; consistency is not checked.',
  'Unannotated secrets or spoilers in prose are not detected. factIds are author-declared assertions, not proof about the text.',
  'Pacing, tone, meaningful choices and audience suitability are not assessed.',
  'Names, places and events are not checked against real people or real events.',
] as const;

export const REVIEW_CHECKLIST = [
  'Unannotated secrets: no template reveals, hints at or presupposes a fact its speaker/scene has not disclosed.',
  'Contradictions: prose agrees with itself, with every fact text and with the ending summaries on every route.',
  'Pacing: scenes are neither padded nor rushed; the three decisions fall at sensible moments.',
  'Meaningful choices: each decision changes something the player can notice; no choice is cosmetic or a trap.',
  'Audience: content, tone and language suit the intended audience; nothing harmful, defamatory or confusing.',
  'Originality: characters, places and events are invented and do not resemble real people or real events.',
  'Endings: both endings feel earned and are distinguishable; summaries match what the route established.',
] as const;

export interface ReviewModel {
  stats: {
    scenes: number;
    decisionPoints: number;
    characters: number;
    endings: number;
    facts: number;
    items: number;
    flags: number;
    choices: number;
    templates: number;
  };
  characters: Array<{
    id: string;
    name: string;
    role: string;
    isPlayer: boolean;
    initialFacts: string[];
    learnedViaChoices: Array<{ choiceId: string; factId: string }>;
    asserts: Array<{ templateId: string; factIds: string[] }>;
  }>;
  facts: Array<{
    id: string;
    text: string;
    initiallyKnownBy: string[];
    learnedBy: Array<{ choiceId: string; who: string }>;
    assertedIn: Array<{ templateId: string; speakerId: string }>;
    requiredBy: string[];
  }>;
  items: Array<{
    id: string;
    name: string;
    oneTime: boolean;
    heldAtStart: boolean;
    givenBy: string[];
    consumedBy: string[];
    requiredBy: string[];
  }>;
  branchPrerequisites: Array<{
    choiceId: string;
    sceneId: string;
    label: string;
    to: string;
    requires: Array<{ requirement: string; obtainableVia: string[] }>;
    effects: string[];
  }>;
  templates: Array<{
    sceneId: string;
    sceneTitle: string;
    templateId: string;
    speakerId: string | null;
    factIds: string[];
    when: string[];
    text: string;
  }>;
}

const renderRequirement = (r: Requirement): string => {
  switch (r.kind) {
    case 'playerKnows':
      return `playerKnows ${r.fact}`;
    case 'hasItem':
      return `hasItem ${r.item}`;
    case 'flag':
      return `flag ${r.flag}`;
    case 'notFlag':
      return `notFlag ${r.flag}`;
  }
};

const renderEffect = (e: Effect): string => {
  switch (e.kind) {
    case 'learnFact':
      return `learnFact ${e.fact}`;
    case 'npcLearns':
      return `npcLearns ${e.character} ${e.fact}`;
    case 'giveItem':
      return `giveItem ${e.item}`;
    case 'consumeItem':
      return `consumeItem ${e.item}`;
    case 'setFlag':
      return `setFlag ${e.flag}`;
  }
};

export function buildReviewModel(scenario: ScenarioDefinition): ReviewModel {
  const player = scenario.characters.find((c) => c.isPlayer)?.id ?? '';
  const choices = scenario.scenes.flatMap((scene) =>
    scene.choices.map((choice) => ({ scene, choice })),
  );
  const templates = scenario.scenes.flatMap((scene) =>
    scene.narration.map((template) => ({ scene, template })),
  );
  const sorted = (xs: string[]) => [...new Set(xs)].sort();

  const learners = (factId: string) =>
    choices.flatMap(({ choice }) =>
      choice.effects.flatMap((e) =>
        e.kind === 'learnFact' && e.fact === factId
          ? [{ choiceId: choice.id, who: player }]
          : e.kind === 'npcLearns' && e.fact === factId
            ? [{ choiceId: choice.id, who: e.character }]
            : [],
      ),
    );
  const choicesWith = (predicate: (e: Effect) => boolean) =>
    sorted(
      choices.filter(({ choice }) => choice.effects.some(predicate)).map(({ choice }) => choice.id),
    );
  const requiring = (predicate: (r: Requirement) => boolean) =>
    sorted([
      ...choices
        .filter(({ choice }) => (choice.requires ?? []).some(predicate))
        .map(({ choice }) => choice.id),
      ...templates
        .filter(({ template }) => (template.when ?? []).some(predicate))
        .map(({ template }) => template.id),
    ]);

  const obtainableVia = (r: Requirement): string[] => {
    switch (r.kind) {
      case 'playerKnows': {
        const via = choicesWith((e) => e.kind === 'learnFact' && e.fact === r.fact);
        return scenario.initial.playerKnowledge.includes(r.fact)
          ? ['(known at start)', ...via]
          : via;
      }
      case 'hasItem': {
        const via = choicesWith((e) => e.kind === 'giveItem' && e.item === r.item);
        return scenario.initial.inventory.includes(r.item) ? ['(held at start)', ...via] : via;
      }
      case 'flag':
        return choicesWith((e) => e.kind === 'setFlag' && e.flag === r.flag);
      case 'notFlag':
        return [
          '(holds until set by)',
          ...choicesWith((e) => e.kind === 'setFlag' && e.flag === r.flag),
        ];
    }
  };

  return {
    stats: {
      scenes: scenario.scenes.length,
      decisionPoints: countDecisionPoints(scenario),
      characters: scenario.characters.length,
      endings: scenario.endings.length,
      facts: scenario.facts.length,
      items: scenario.items.length,
      flags: scenario.flags.length,
      choices: choices.length,
      templates: templates.length,
    },
    characters: scenario.characters.map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      isPlayer: c.isPlayer,
      initialFacts: c.isPlayer
        ? [...scenario.initial.playerKnowledge].sort()
        : [...(scenario.initial.npcKnowledge[c.id] ?? [])].sort(),
      learnedViaChoices: choices.flatMap(({ choice }) =>
        choice.effects.flatMap((e) =>
          c.isPlayer && e.kind === 'learnFact'
            ? [{ choiceId: choice.id, factId: e.fact }]
            : !c.isPlayer && e.kind === 'npcLearns' && e.character === c.id
              ? [{ choiceId: choice.id, factId: e.fact }]
              : [],
        ),
      ),
      asserts: templates
        .filter(
          ({ template }) => template.speakerId === c.id && (template.factIds ?? []).length > 0,
        )
        .map(({ template }) => ({
          templateId: template.id,
          factIds: [...(template.factIds ?? [])],
        })),
    })),
    facts: scenario.facts.map((f) => ({
      id: f.id,
      text: f.text,
      initiallyKnownBy: [
        ...(scenario.initial.playerKnowledge.includes(f.id) ? [player] : []),
        ...Object.entries(scenario.initial.npcKnowledge)
          .filter(([, known]) => known.includes(f.id))
          .map(([id]) => id),
      ].sort(),
      learnedBy: learners(f.id),
      assertedIn: templates
        .filter(({ template }) => (template.factIds ?? []).includes(f.id))
        .map(({ template }) => ({ templateId: template.id, speakerId: template.speakerId ?? '' })),
      requiredBy: requiring((r) => r.kind === 'playerKnows' && r.fact === f.id),
    })),
    items: scenario.items.map((i) => ({
      id: i.id,
      name: i.name,
      oneTime: i.oneTime,
      heldAtStart: scenario.initial.inventory.includes(i.id),
      givenBy: choicesWith((e) => e.kind === 'giveItem' && e.item === i.id),
      consumedBy: choicesWith((e) => e.kind === 'consumeItem' && e.item === i.id),
      requiredBy: requiring((r) => r.kind === 'hasItem' && r.item === i.id),
    })),
    branchPrerequisites: choices.map(({ scene, choice }) => ({
      choiceId: choice.id,
      sceneId: scene.id,
      label: choice.label,
      to: choice.to,
      requires: (choice.requires ?? []).map((r) => ({
        requirement: renderRequirement(r),
        obtainableVia: obtainableVia(r),
      })),
      effects: choice.effects.map(renderEffect),
    })),
    templates: templates.map(({ scene, template }) => ({
      sceneId: scene.id,
      sceneTitle: scene.title,
      templateId: template.id,
      speakerId: template.speakerId ?? null,
      factIds: [...(template.factIds ?? [])],
      when: (template.when ?? []).map(renderRequirement),
      text: template.text,
    })),
  };
}

// ── Markdown ────────────────────────────────────────────────────────────────

const cell = (text: string) => text.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
const line = (text: string) => text.replace(/[\r\n]+/g, ' ');
const list = (xs: readonly string[]) => (xs.length > 0 ? xs.join(', ') : '—');
const code = (xs: readonly string[]) =>
  xs.length > 0 ? xs.map((x) => `\`${x}\``).join(', ') : '—';

type ReviewRequired = Extract<AuthoringResult, { status: 'REVIEW_REQUIRED' }>;

export function renderReviewReport(result: ReviewRequired): string {
  const model = buildReviewModel(result.scenario);
  const { scenario, validation, provenance } = result;
  const titleOf = new Map(scenario.scenes.map((s) => [s.id, s.title]));
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines);

  push(
    `# Review report: ${line(scenario.title)} (\`${scenario.id}\` v${scenario.version})`,
    '',
    '> **STATUS: REVIEW_REQUIRED — mechanically valid, NOT approved, NOT published.**',
    '> Mechanical validity means the declared rules and routes check out. It does not mean the',
    '> prose is consistent, spoiler-free, suitable or safe to publish. A human editor must read it.',
    '',
    '## Identity and provenance',
    '',
    `- Candidate hash: \`${result.candidateHash}\``,
    `- Brief hash: \`${provenance.briefHash ?? ''}\``,
    `- Provider: ${provenance.provider}${provenance.model ? ` (model \`${provenance.model}\`)` : ''}`,
    `- Prompt version: \`${provenance.promptVersion}\`; wire schema: \`${provenance.schemaVersion}\``,
    `- Repaired: ${result.repaired ? 'yes (one repair request, fully re-validated)' : 'no'}`,
    `- Provider requests: ${provenance.requests.length}; HTTP attempts: ${provenance.totalHttpAttempts} (budget ${provenance.callBudget.maxHttpAttempts})`,
    ...provenance.requests.map(
      (r) =>
        `  - ${r.phase}: ${r.outcome}, attempts ${r.httpAttempts}, ${r.durationMs} ms, tokens in/out ${r.inputTokens ?? 'n/a'}/${r.outputTokens ?? 'n/a'}`,
    ),
    '',
    '## Validation results',
    '',
    ...validation.stages.map((s) => `- [x] ${s.stage}`),
    '',
    '## Reachability summary',
    '',
    `- Reachable states explored: ${validation.analysis.reachableStateCount}`,
    `- Reachable endings: ${code(validation.analysis.reachableEndings)}`,
    `- Choices usable by some route: ${validation.analysis.usedChoiceCount} of ${validation.analysis.totalChoiceCount}`,
    `- Canonical narration accepted in ${validation.narrationStatesChecked} reachable states`,
    `- Size: ${model.stats.scenes} scenes, ${model.stats.decisionPoints} decision points, ${model.stats.choices} choices, ${model.stats.templates} narration templates, ${model.stats.characters} characters, ${model.stats.facts} facts, ${model.stats.items} items, ${model.stats.flags} flags`,
    '',
    '## Witness routes (shortest route to each ending; replayed with real transition rules)',
    '',
  );
  for (const route of validation.witnessRoutes) {
    push(
      `### Ending \`${route.endingId}\` (${route.choiceIds.length} choices, ${route.stepsVerified} steps replayed)`,
      '',
      ...route.sceneIds.map((id, i) => {
        const choice = route.choiceIds[i];
        return `${i + 1}. ${line(titleOf.get(id) ?? id)} (\`${id}\`)${choice ? ` → choose \`${choice}\`` : ' → end'}`;
      }),
      '',
    );
  }

  push('## Character knowledge', '');
  for (const c of model.characters) {
    push(
      `### ${line(c.name)} (\`${c.id}\`, ${line(c.role)}${c.isPlayer ? ', player' : ''})`,
      '',
      `- Knows at start: ${code(c.initialFacts)}`,
      `- Learns via choices: ${c.learnedViaChoices.length > 0 ? c.learnedViaChoices.map((l) => `\`${l.factId}\` (\`${l.choiceId}\`)`).join(', ') : '—'}`,
      `- Declared to assert (templates): ${c.asserts.length > 0 ? c.asserts.map((a) => `\`${a.templateId}\` → ${code(a.factIds)}`).join('; ') : '—'}`,
      '',
    );
  }

  push(
    '## Fact disclosures',
    '',
    '| Fact | Text | Known at start by | Learned by (choice → who) | Asserted in (template → speaker) | Required by |',
    '| --- | --- | --- | --- | --- | --- |',
    ...model.facts.map(
      (f) =>
        `| \`${f.id}\` | ${cell(f.text)} | ${list(f.initiallyKnownBy)} | ${f.learnedBy.length > 0 ? f.learnedBy.map((l) => `${l.choiceId} → ${l.who}`).join('; ') : '—'} | ${f.assertedIn.length > 0 ? f.assertedIn.map((a) => `${a.templateId} → ${a.speakerId}`).join('; ') : '—'} | ${list(f.requiredBy)} |`,
    ),
    '',
    '## Items and consumption',
    '',
    '| Item | Name | One-time | Held at start | Given by | Consumed by | Required by |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...model.items.map(
      (i) =>
        `| \`${i.id}\` | ${cell(i.name)} | ${i.oneTime ? 'yes' : 'no'} | ${i.heldAtStart ? 'yes' : 'no'} | ${list(i.givenBy)} | ${list(i.consumedBy)} | ${list(i.requiredBy)} |`,
    ),
    '',
    '## Branch prerequisites and effects',
    '',
  );
  for (const b of model.branchPrerequisites) {
    push(
      `- \`${b.choiceId}\` in \`${b.sceneId}\` → \`${b.to}\`: “${line(b.label)}”`,
      ...(b.requires.length > 0
        ? b.requires.map(
            (r) => `  - requires \`${r.requirement}\` — obtainable via: ${list(r.obtainableVia)}`,
          )
        : ['  - requires: nothing']),
      `  - effects: ${b.effects.length > 0 ? code(b.effects) : '—'}`,
    );
  }

  push('', '## Narration templates (verbatim, with declared annotations)', '');
  let currentScene = '';
  for (const t of model.templates) {
    if (t.sceneId !== currentScene) {
      currentScene = t.sceneId;
      push(`### ${line(t.sceneTitle)} (\`${t.sceneId}\`)`, '');
    }
    push(
      `**\`${t.templateId}\`** — speaker: ${t.speakerId ? `\`${t.speakerId}\`` : 'none'}; asserts: ${code(t.factIds)}; shown when: ${t.when.length > 0 ? code(t.when) : 'always'}`,
      '',
      `> ${line(t.text)}`,
      '',
    );
  }

  push('## Endings', '');
  for (const e of scenario.endings) {
    push(`- \`${e.id}\` — **${line(e.title)}**: ${line(e.summary)}`);
  }

  push(
    '',
    '## What this validation does NOT prove',
    '',
    ...NOT_PROVEN.map((n) => `- ${n}`),
    '',
    '## Editorial checklist (to be completed by a human; nothing here is recorded automatically)',
    '',
    ...REVIEW_CHECKLIST.map((c) => `- [ ] ${c}`),
    '',
    'Reviewer: ____________  Decision: ____________  Date: ____________',
    '',
    'A PENDING `approval-template.json` sits beside this report, bound to the hash above. Only a',
    'person completes it by hand; `pnpm preflight:interactive` then re-checks the exact candidate.',
    '',
    'Publication is a separate, explicit, manual step (a new registry entry plus tests). This',
    'tool has no approve or publish command.',
    '',
  );
  return out.join('\n');
}

// ── Machine-readable reports ────────────────────────────────────────────────

export function buildValidationReport(result: ReviewRequired) {
  return {
    status: result.status,
    approved: false as const,
    editorialStatus: 'UNREVIEWED' as const,
    publication: 'NOT_PUBLISHED' as const,
    mechanicalValidity: 'passed' as const,
    notProven: [...NOT_PROVEN],
    candidate: {
      id: result.scenario.id,
      version: result.scenario.version,
      title: result.scenario.title,
      hash: result.candidateHash,
    },
    repaired: result.repaired,
    stages: result.validation.stages,
    analysis: result.validation.analysis,
    witnessRoutes: result.validation.witnessRoutes,
    narrationStatesChecked: result.validation.narrationStatesChecked,
    provenance: result.provenance,
  };
}

export function buildFailureReport(
  result: Extract<AuthoringResult, { status: 'REJECTED' | 'STOPPED' }>,
) {
  const base = {
    status: result.status,
    approved: false as const,
    publication: 'NOT_PUBLISHED' as const,
    candidateFile: null,
    provenance: result.provenance,
  };
  if (result.status === 'REJECTED') {
    return {
      ...base,
      failedStage: result.stage,
      repair: result.repair,
      diagnostics: result.diagnostics,
      droppedDiagnostics: result.droppedDiagnostics,
      rejectedOutputSha256: result.rawSha256,
    };
  }
  return {
    ...base,
    stopReason: result.reason,
    phase: result.phase,
    priorDiagnostics: result.priorDiagnostics,
  };
}
