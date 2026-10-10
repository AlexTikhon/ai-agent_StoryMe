import { hashScenarioDefinition, type ScenarioDefinition } from '../domain/scenario-schema';
import {
  createScenarioRegistry,
  type ScenarioCatalogueMetadata,
  type ScenarioRegistry,
} from '../scenarios/registry';
import {
  checkApproval,
  parseApprovalRecord,
  type ApprovalFailureCode,
  type ApprovalRecord,
} from './approval';

/**
 * The registration guard. A definition becomes startable and listed only if it
 * is either (a) pinned in the legacy baseline by exact identity AND canonical
 * hash, or (b) covered by exactly one matching, approved editorial record.
 *
 * It lives at the composition boundary of the REAL registry; the injectable
 * `createScenarioRegistry` used by tests stays guard-free. It imports only the
 * registry factory and the approval module, never authoring or the real registry.
 */

/** Content that was published before approval records existed. Not a retrospective approval. */
export interface LegacyBaselineEntry {
  id: string;
  version: number;
  /** Canonical hash (hashScenarioDefinition) of the exact published definition. */
  candidateHash: string;
  reason: 'EXISTING_PUBLISHED_CONTENT';
}

export type PublicationGuardCode =
  ApprovalFailureCode | 'APPROVAL_MISSING' | 'APPROVAL_DUPLICATE' | 'LEGACY_BASELINE_HASH_MISMATCH';

export class PublicationGuardError extends Error {
  constructor(
    readonly code: PublicationGuardCode,
    readonly identity: string,
    detail: string,
  ) {
    super(`Refusing to register ${identity}: ${code} (${detail})`);
    this.name = 'PublicationGuardError';
  }
}

export interface GuardedRegistryInput {
  definitions: readonly ScenarioDefinition[];
  metadata: readonly ScenarioCatalogueMetadata[];
  /** Raw approval records (e.g. parsed JSON); parsed strictly here. */
  approvals: readonly unknown[];
  legacyBaseline: readonly LegacyBaselineEntry[];
  now?: Date;
}

const key = (id: string, version: number) => `${id}@${version}`;

export function assertPublicationGuard(input: Omit<GuardedRegistryInput, 'metadata'>): void {
  const now = input.now ?? new Date();
  const records = new Map<string, ApprovalRecord>();
  for (const raw of input.approvals) {
    const parsed = parseApprovalRecord(raw);
    if (!parsed.ok)
      throw new PublicationGuardError(parsed.code, '(approval record)', parsed.message);
    const id = key(parsed.record.scenario.id, parsed.record.scenario.version);
    if (records.has(id)) {
      throw new PublicationGuardError('APPROVAL_DUPLICATE', id, 'more than one approval record');
    }
    records.set(id, parsed.record);
  }

  for (const definition of input.definitions) {
    const identity = key(definition.id, definition.version);
    const candidateHash = hashScenarioDefinition(definition);

    const legacy = input.legacyBaseline.find(
      (entry) => entry.id === definition.id && entry.version === definition.version,
    );
    if (legacy) {
      // Published definitions are append-only: a legacy identity may only ever be the pinned content.
      if (legacy.candidateHash !== candidateHash) {
        throw new PublicationGuardError(
          'LEGACY_BASELINE_HASH_MISMATCH',
          identity,
          'definition differs from the pinned legacy content',
        );
      }
      continue;
    }

    const record = records.get(identity);
    if (!record) {
      throw new PublicationGuardError('APPROVAL_MISSING', identity, 'no approval record');
    }
    const checked = checkApproval(
      record,
      { id: definition.id, version: definition.version, candidateHash },
      now,
    );
    if (!checked.ok) throw new PublicationGuardError(checked.code, identity, checked.message);
  }
}

/** Guard first, then the ordinary registry factory. Throws PublicationGuardError. */
export function createGuardedScenarioRegistry(input: GuardedRegistryInput): ScenarioRegistry {
  assertPublicationGuard(input);
  return createScenarioRegistry(input.definitions, input.metadata);
}
