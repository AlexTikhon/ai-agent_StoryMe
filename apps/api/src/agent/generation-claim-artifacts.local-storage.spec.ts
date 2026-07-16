import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BookLayoutEntry } from '@book/types';
import {
  LocalImageAssetStorage,
  claimImageAssetKey,
  buildImageBufferResolver,
} from '../images/image-asset-storage';
import type { ClaimArtifactNamespace } from './generation-artifact-namespace';

// Phase B, Slice B3's central correctness claim: two claims of the *same*
// GenerationRun (a stalled-redelivery reclaim bumps fencingVersion, not
// runId — see GenerationRunService.claim) write to provably distinct
// storage keys, so a stale worker's late write can never land on the
// bytes a newer claim's renderer reads — not because of timing or
// ordering, but because the keys themselves never collide. This exercises
// the real LocalImageAssetStorage driver (no mocks) to prove that at the
// filesystem level, not just in claimImageAssetKey's own unit tests.
describe('claim-scoped image key isolation under a same-run redelivery race — real local storage', () => {
  const BOOK_ID = 'race-test-book';
  const RUN_ID = 'race-run';
  const CLAIM_A: ClaimArtifactNamespace = { kind: 'claim', runId: RUN_ID, fencingVersion: 1 };
  const CLAIM_B: ClaimArtifactNamespace = { kind: 'claim', runId: RUN_ID, fencingVersion: 2 };
  const ROOT = resolve(process.cwd(), 'tmp', 'images', 'books', BOOK_ID);

  afterEach(async () => {
    if (existsSync(ROOT)) {
      await rm(ROOT, { recursive: true });
    }
  });

  function makeCoverEntry(): BookLayoutEntry {
    return {
      id: 'race-cover-entry',
      kind: 'cover',
      template: 'cover_full_bleed',
      trimSize: 'square_8x8',
      canvas: { width: 2400, height: 2400, unit: 'px' },
      safeArea: { x: 180, y: 180, width: 2040, height: 2040 },
      bleed: 90,
      imageBlock: {
        box: { x: 0, y: 0, width: 2400, height: 2400 },
        imageUrl: `/mock-images/${BOOK_ID}/cover.svg`,
        altText: 'Cover illustration',
        objectFit: 'cover',
      },
      notes: [],
    };
  }

  it("claim A's late write after claim B never alters B's bytes, and B's resolver reads only B's bytes", async () => {
    const storage = new LocalImageAssetStorage();
    const keyA = claimImageAssetKey(BOOK_ID, CLAIM_A, 'cover');
    const keyB = claimImageAssetKey(BOOK_ID, CLAIM_B, 'cover');
    expect(keyA).not.toBe(keyB);

    // Claim B (the newer claim that reclaimed the run after a stalled
    // redelivery) completes its write first.
    await storage.saveImageAsset(keyB, Buffer.from('claim-B-bytes'), 'image/png');
    // Claim A (the stale worker, still unaware it's been superseded) writes
    // its own bytes for the *same logical cover page* after B — the exact
    // "late write from a superseded claim" race Phase B closes for artifact
    // storage (see docs/local-generation-pipeline.md's "Run-scoped artifact
    // storage" gap this slice fixes).
    await storage.saveImageAsset(keyA, Buffer.from('claim-A-bytes'), 'image/png');

    const bytesAtB = await storage.getImageAsset(keyB);
    expect(bytesAtB!.equals(Buffer.from('claim-B-bytes'))).toBe(true);
    const bytesAtA = await storage.getImageAsset(keyA);
    expect(bytesAtA!.equals(Buffer.from('claim-A-bytes'))).toBe(true);

    const entries = [makeCoverEntry()];
    const resolveForB = await buildImageBufferResolver(storage, BOOK_ID, entries, CLAIM_B);
    const resolvedForB = resolveForB(entries[0]!.imageBlock!, entries[0]!);
    expect(resolvedForB!.equals(Buffer.from('claim-B-bytes'))).toBe(true);

    const resolveForA = await buildImageBufferResolver(storage, BOOK_ID, entries, CLAIM_A);
    const resolvedForA = resolveForA(entries[0]!.imageBlock!, entries[0]!);
    expect(resolvedForA!.equals(Buffer.from('claim-A-bytes'))).toBe(true);
  });
});
