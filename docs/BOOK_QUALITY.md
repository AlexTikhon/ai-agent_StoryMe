# StoryMe book quality

## Quality contract

Every generated story receives a deterministic `QualityReport`. It uses pass/fail
dimensions rather than a synthetic score:

- structural validity;
- personalization;
- protagonist consistency;
- age appropriateness;
- continuity;
- acceptable repetition;
- page progression;
- ending quality.

The report contains privacy-safe issue codes/messages and affected page numbers,
not generated prose or prompts. Checks include expected/non-empty pages and
titles, cross-artifact agreement, age-banded length, protagonist coverage,
name/theme/age/lesson alignment, exact and near duplicates, repeated sentences
and page edges, distinct scene progression, and a non-empty resolved ending.
Heuristics are deliberately conservative and require no model call.

## Bounded repair

The workflow remains:

```text
story -> deterministic QA -> pass
                       |
                       `-> one optional repair -> deterministic QA -> pass/fail
```

Repair is disabled by default. When explicitly enabled, it is allowed only for
repairable findings and can invoke the configured story provider once. The
repair prompt includes the versioned story contract, bounded child context, the
complete candidate, and specific safe issue directives. There is no reflection
or retry loop above the provider's existing bounded HTTP retry policy.

## Character visual bible

`CharacterVisualBible` is the canonical stable identity projection derived only
from the existing character profile. It contains the protagonist name,
approximate age, known hair/eyes/face description, default wardrobe, visual
style, identity rules, scene-flexibility rules, and the existing appearance
fingerprint. It does not infer missing or sensitive attributes.

```text
Character profile
       |
       v
Visual Bible
   /       \
  v         v
reference  cover/page/back-cover prompts
```

The focused image prompt builder separates the stable visual bible from the
variable scene (theme, action, location, mood, and relevant supporting details).
Pose, expression, setting, and intentional story-required wardrobe changes may
vary; identity, approximate age, and visual style may not. A valid generated
character sheet is still supplied through the provider's existing reference
abstraction. No image-review call was added.

## Prompt versions and hygiene

`PROMPT_VERSIONS` source-controls five independent contracts:

| Prompt              | Version                  |
| ------------------- | ------------------------ |
| Character profile   | `character-profile-v2`   |
| Story               | `story-v3`               |
| Story repair        | `story-repair-v2`        |
| Character reference | `character-reference-v3` |
| Page image          | `page-image-v3`          |

User-provided child context is JSON-delimited and explicitly treated as data,
with DTO and immutable-snapshot size/range validation. Tests assert semantic
prompt content and exclude unresolved values such as `undefined` and
`[object Object]`. Diagnostics expose prompt versions/hashes but never raw
prompts, provider responses, child images, base64, or credentials.

## Book/PDF validation

Before PDF rendering, the structured layout must contain exactly one cover, all
ordered story pages, and one back cover. Every entry must have non-empty text
and a planned illustration, and no unresolved placeholder/null-like value may
reach rendering. Artifact byte resolution remains claim-scoped and is checked
again by the existing PDF publication stage.

## Offline evaluation

Run:

```bash
pnpm eval:story:offline
```

It requires no API key and makes zero external requests. The corpus uses only
synthetic names and covers ages 3-11, short/long names, 4/6/8/12-page books,
English/Polish/Russian, everyday life, adventure, space, animals, fantasy,
minimal personalization, and optional lessons. Malformed variants verify
missing pages, duplicate pages, wrong protagonist, empty ending, excessive
repetition, missing personalization, and invalid title structure.

## Optional paid evaluation

Paid evaluation is never part of test, build, integration tests, or CI. Run it
manually only with an explicit opt-in:

```bash
RUN_PAID_AI_EVALS=true pnpm --filter @book/api eval:story:openai
```

Use `AI_EVAL_JSON_PATH` to write the candidate JSON. To compare a prior result,
set `AI_EVAL_BASELINE_JSON_PATH`; optionally set `AI_EVAL_COMPARISON_PATH`,
`AI_EVAL_BASELINE_LABEL`, and `AI_EVAL_CANDIDATE_LABEL`. The Markdown comparison
reports valid generations, repair requirement/attempts, token use, estimated
cost, and latency. It does not reduce subjective story quality to one score.

## Provider-call budget

Phase 13 adds no normal-path provider call. The ordinary budget remains one
character-profile call, one character-sheet image, one story call, required
cover/page/back-cover images, and at most one explicitly enabled repair call.
