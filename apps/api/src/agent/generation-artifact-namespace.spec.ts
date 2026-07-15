import { describe, it, expect } from 'vitest';
import {
  claimArtifactBasePath,
  claimNamespace,
  InvalidGenerationArtifactPointerError,
  LEGACY_NAMESPACE,
  resolveLastGenerationNamespace,
  resolvePublishedNamespace,
} from './generation-artifact-namespace';

const RUN_A = '11111111-1111-1111-1111-111111111111';
const RUN_B = '22222222-2222-2222-2222-222222222222';

describe('claimNamespace', () => {
  it('builds a claim namespace from a valid runId + positive fencingVersion', () => {
    expect(claimNamespace(RUN_A, 1)).toEqual({ kind: 'claim', runId: RUN_A, fencingVersion: 1 });
  });

  it('rejects a runId containing a path separator', () => {
    expect(() => claimNamespace('../etc/passwd', 1)).toThrow(InvalidGenerationArtifactPointerError);
  });

  it('rejects a fencingVersion of 0', () => {
    expect(() => claimNamespace(RUN_A, 0)).toThrow(InvalidGenerationArtifactPointerError);
  });

  it('rejects a negative fencingVersion', () => {
    expect(() => claimNamespace(RUN_A, -1)).toThrow(InvalidGenerationArtifactPointerError);
  });

  it('rejects a non-integer fencingVersion', () => {
    expect(() => claimNamespace(RUN_A, 1.5)).toThrow(InvalidGenerationArtifactPointerError);
  });
});

describe('resolveLastGenerationNamespace', () => {
  it('resolves to legacy when both pointer fields are null (pre-Phase-B or never-generated row)', () => {
    expect(
      resolveLastGenerationNamespace({
        lastGenerationRunId: null,
        lastGenerationFencingVersion: null,
      }),
    ).toEqual(LEGACY_NAMESPACE);
  });

  it('resolves to the exact claim when both pointer fields are set', () => {
    expect(
      resolveLastGenerationNamespace({
        lastGenerationRunId: RUN_A,
        lastGenerationFencingVersion: 2,
      }),
    ).toEqual({ kind: 'claim', runId: RUN_A, fencingVersion: 2 });
  });

  it('throws when runId is set but fencingVersion is null', () => {
    expect(() =>
      resolveLastGenerationNamespace({
        lastGenerationRunId: RUN_A,
        lastGenerationFencingVersion: null,
      }),
    ).toThrow(InvalidGenerationArtifactPointerError);
  });

  it('throws when fencingVersion is set but runId is null', () => {
    expect(() =>
      resolveLastGenerationNamespace({
        lastGenerationRunId: null,
        lastGenerationFencingVersion: 2,
      }),
    ).toThrow(InvalidGenerationArtifactPointerError);
  });
});

describe('resolvePublishedNamespace', () => {
  it('resolves to null when nothing has ever been published', () => {
    expect(
      resolvePublishedNamespace({ publishedRunId: null, publishedRunFencingVersion: null }),
    ).toBeNull();
  });

  it('resolves to legacy when publishedRunId is set but publishedRunFencingVersion is not (pre-Phase-B completion)', () => {
    expect(
      resolvePublishedNamespace({ publishedRunId: RUN_A, publishedRunFencingVersion: null }),
    ).toEqual(LEGACY_NAMESPACE);
  });

  it('resolves to the exact claim when both published pointer fields are set', () => {
    expect(
      resolvePublishedNamespace({ publishedRunId: RUN_A, publishedRunFencingVersion: 3 }),
    ).toEqual({ kind: 'claim', runId: RUN_A, fencingVersion: 3 });
  });

  it('throws when publishedRunFencingVersion is set but publishedRunId is null', () => {
    expect(() =>
      resolvePublishedNamespace({ publishedRunId: null, publishedRunFencingVersion: 3 }),
    ).toThrow(InvalidGenerationArtifactPointerError);
  });
});

describe('claimArtifactBasePath', () => {
  it('embeds both the bookId and the full (runId, fencingVersion) claim identity', () => {
    expect(
      claimArtifactBasePath('book-1', { kind: 'claim', runId: RUN_A, fencingVersion: 1 }),
    ).toBe('books/book-1/runs/11111111-1111-1111-1111-111111111111/claims/1');
  });

  it('differs for the same runId across two fencing versions (stalled-redelivery reclaim)', () => {
    const v1 = claimArtifactBasePath('book-1', { kind: 'claim', runId: RUN_A, fencingVersion: 1 });
    const v2 = claimArtifactBasePath('book-1', { kind: 'claim', runId: RUN_A, fencingVersion: 2 });
    expect(v1).not.toBe(v2);
  });

  it('differs for two different runIds at the same fencingVersion', () => {
    const a = claimArtifactBasePath('book-1', { kind: 'claim', runId: RUN_A, fencingVersion: 1 });
    const b = claimArtifactBasePath('book-1', { kind: 'claim', runId: RUN_B, fencingVersion: 1 });
    expect(a).not.toBe(b);
  });

  it('rejects a bookId containing a path separator', () => {
    expect(() =>
      claimArtifactBasePath('../etc/passwd', { kind: 'claim', runId: RUN_A, fencingVersion: 1 }),
    ).toThrow(InvalidGenerationArtifactPointerError);
  });

  it('rejects a non-positive fencingVersion even in a namespace built as a raw literal (bypassing claimNamespace)', () => {
    expect(() =>
      claimArtifactBasePath('book-1', { kind: 'claim', runId: RUN_A, fencingVersion: 0 }),
    ).toThrow(InvalidGenerationArtifactPointerError);
  });

  it('rejects a malformed runId even in a namespace built as a raw literal (bypassing claimNamespace)', () => {
    expect(() =>
      claimArtifactBasePath('book-1', { kind: 'claim', runId: '../etc/passwd', fencingVersion: 1 }),
    ).toThrow(InvalidGenerationArtifactPointerError);
  });
});
