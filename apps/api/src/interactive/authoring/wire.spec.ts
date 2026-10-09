import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseScenarioDefinition } from '../domain/scenario-schema';
import { LAST_TRAM_SCENARIO } from './the-last-tram';
import {
  normalizeWire,
  scenarioToWire,
  WIRE_JSON_SCHEMA,
  WIRE_RESPONSE_FORMAT,
  wireScenarioSchema,
} from './wire';

type Json = Record<string, unknown>;

/**
 * Structural rules of OpenAI strict Structured Outputs
 * (https://developers.openai.com/api/docs/guides/structured-outputs): root object,
 * every property required, additionalProperties:false on every object, nesting
 * <= 10 levels, <= 5000 properties, no unsupported keywords.
 */
const UNSUPPORTED = ['allOf', 'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas'];
// We deliberately avoid even the supported-but-optional constraint keywords, so the
// provider schema only constrains shape and local validation stays authoritative.
const AVOIDED = [
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
];

function walk(
  schema: Json,
  depth: number,
  stats: { props: number; maxDepth: number },
  path: string,
) {
  stats.maxDepth = Math.max(stats.maxDepth, depth);
  for (const keyword of [...UNSUPPORTED, ...AVOIDED, 'anyOf', '$ref', 'default']) {
    expect(schema, `${path} must not use ${keyword}`).not.toHaveProperty(keyword);
  }
  if (schema['type'] === 'object') {
    const properties = schema['properties'] as Record<string, Json>;
    expect(schema['additionalProperties'], `${path} additionalProperties`).toBe(false);
    expect([...(schema['required'] as string[])].sort(), `${path} required`).toEqual(
      Object.keys(properties).sort(),
    );
    for (const [key, child] of Object.entries(properties)) {
      stats.props += 1;
      walk(child, depth + 1, stats, `${path}.${key}`);
    }
  } else if (schema['type'] === 'array') {
    walk(schema['items'] as Json, depth + 1, stats, `${path}[]`);
  }
}

/** Keys of the hand-written JSON schema must equal the keys of the Zod wire schema. */
function sameShape(zod: z.ZodTypeAny, json: Json, path: string) {
  let inner: z.ZodTypeAny = zod;
  while (inner instanceof z.ZodNullable) inner = inner.unwrap();
  if (inner instanceof z.ZodArray) {
    expect(json['type'], path).toBe('array');
    sameShape(inner.element, json['items'] as Json, `${path}[]`);
  } else if (inner instanceof z.ZodObject) {
    const properties = json['properties'] as Record<string, Json>;
    expect(Object.keys(properties).sort(), path).toEqual(Object.keys(inner.shape).sort());
    for (const [key, child] of Object.entries(inner.shape)) {
      sameShape(child as z.ZodTypeAny, properties[key]!, `${path}.${key}`);
    }
  }
}

describe('provider JSON schema', () => {
  it('satisfies the strict Structured Outputs structural rules', () => {
    expect(WIRE_JSON_SCHEMA['type']).toBe('object');
    const stats = { props: 0, maxDepth: 0 };
    walk(WIRE_JSON_SCHEMA, 1, stats, '$');
    expect(stats.maxDepth).toBeLessThanOrEqual(10);
    expect(stats.props).toBeLessThanOrEqual(5000);
  });

  it('is wrapped as a strict json_schema response format', () => {
    expect(WIRE_RESPONSE_FORMAT.type).toBe('json_schema');
    expect(WIRE_RESPONSE_FORMAT.json_schema.strict).toBe(true);
    expect(WIRE_RESPONSE_FORMAT.json_schema.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('does not drift from the strict local wire schema', () => {
    sameShape(wireScenarioSchema, WIRE_JSON_SCHEMA, '$');
  });

  it('represents optional values as required nullable fields and dynamic maps as entry arrays', () => {
    const scene = ((WIRE_JSON_SCHEMA['properties'] as Record<string, Json>)['scenes'] as Json)[
      'items'
    ] as Json;
    const sceneProps = scene['properties'] as Record<string, Json>;
    expect(sceneProps['endingId']).toEqual({ type: ['string', 'null'] });
    const knowledge = (WIRE_JSON_SCHEMA['properties'] as Record<string, Json>)[
      'initialNpcKnowledge'
    ]!;
    expect(knowledge['type']).toBe('array');
  });
});

describe('wire normalization', () => {
  it('round-trips the runtime definition exactly', () => {
    const wire = wireScenarioSchema.parse(
      JSON.parse(JSON.stringify(scenarioToWire(LAST_TRAM_SCENARIO))),
    );
    const normalized = normalizeWire(wire);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(parseScenarioDefinition(normalized.candidate)).toEqual(LAST_TRAM_SCENARIO);
  });

  it('omits empty optional fields instead of emitting empty arrays or nulls', () => {
    const normalized = normalizeWire(scenarioToWire(LAST_TRAM_SCENARIO));
    if (!normalized.ok) throw new Error('expected ok');
    const scenes = normalized.candidate['scenes'] as Array<{
      endingId?: unknown;
      narration: Array<Json>;
      choices: Array<Json>;
    }>;
    expect(scenes[0]!.narration[0]).not.toHaveProperty('speakerId');
    expect(scenes[0]!.narration[0]).not.toHaveProperty('factIds');
    expect(scenes[0]!.narration[0]).not.toHaveProperty('when');
    expect(scenes[0]).not.toHaveProperty('endingId');
    expect(scenes[0]!.choices[0]).not.toHaveProperty('requires');
    expect(normalized.candidate['language']).toBe('en');
  });

  it('rejects duplicate dynamic-map entries rather than silently overwriting them', () => {
    const wire = structuredClone(scenarioToWire(LAST_TRAM_SCENARIO));
    wire.initialNpcKnowledge.push({ characterId: 'wiktor', factIds: ['f-box-under-panel'] });
    const normalized = normalizeWire(wire);
    expect(normalized.ok).toBe(false);
  });
});
