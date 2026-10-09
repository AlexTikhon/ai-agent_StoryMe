import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit order, no whitespace,
 * arrays kept in the order given. Callers that model a *set* with an array must
 * sort it first (see `normalizeState`); this function never reorders arrays
 * because array order is meaningful for ordered data such as `history`.
 *
 * Throws on values with no canonical form (undefined, NaN, functions, ...) so
 * a hash can never depend on how a value was constructed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('Cannot canonicalize a non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const record = value as Record<string, unknown>;
      const entries = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
      return `{${entries.join(',')}}`;
    }
    default:
      throw new Error(`Cannot canonicalize a value of type ${typeof value}`);
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Sorted, de-duplicated copy: the canonical form of an array that models a set. */
export function toSortedSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
