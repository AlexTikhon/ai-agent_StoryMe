'use client';

import { useEffect, useState } from 'react';
import type { InteractivePresentationPanelDto } from '@book/types';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { getSessionEpoch } from '@/lib/auth/token-store';
import type { AcceptedTranscriptPage } from './accepted-page';
import { checkTranscriptArtwork, type ChapterArtworkPack } from './validate-transcript-artwork';

/** Local deadline per artwork page request; cancelling stops waiting, not necessarily server work. */
export const TRANSCRIPT_ARTWORK_DEADLINE_MS = 10_000;
/** Artwork page requests allowed at once; the rest wait their turn in page order. */
export const MAX_ARTWORK_REQUESTS_IN_FLIGHT = 2;
/** Manual "reload" attempts allowed per artwork page; there are never automatic ones. */
export const MAX_ARTWORK_METADATA_RETRIES = 2;

/**
 * loading – the page's artwork is queued or in flight (a placeholder holds the space).
 * ready   – this chapter has validated panels.
 * none    – nothing to show: no pack, or an answer that was rejected; the text is complete.
 * error   – transport/service failure; a bounded manual retry may be offered.
 */
export type ChapterArtworkStatus = 'loading' | 'ready' | 'none' | 'error';

export interface ChapterArtwork {
  status: ChapterArtworkStatus;
  panels: readonly InteractivePresentationPanelDto[];
  /** Pack identity of `panels`; part of the key that isolates image state. */
  packKey: string;
  /** The error note and its retry belong to one chapter per page: its first. */
  showsNote: boolean;
  canRetry: boolean;
  retry: () => void;
}

type EntryStatus = 'queued' | 'loading' | 'ready' | 'none' | 'error';

interface Entry {
  readonly page: AcceptedTranscriptPage;
  status: EntryStatus;
  retries: number;
  steps: readonly (ChapterArtworkPack | null)[] | null;
  /** Identifies the live request; a completion carrying any other token is stale. */
  token: number;
  active: boolean;
  controller: AbortController | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** What is rendered: an immutable snapshot of one entry. */
interface PageView {
  status: EntryStatus;
  retries: number;
  steps: readonly (ChapterArtworkPack | null)[] | null;
}

type Views = Readonly<Record<string, PageView>>;

interface Scope {
  readonly key: string;
  readonly epoch: number;
  readonly entries: Map<string, Entry>;
  inFlight: number;
}

const EMPTY_VIEWS: Views = Object.freeze({});

/**
 * The request scheduler, kept out of React: one scope at a time, entries in page
 * order, `MAX_ARTWORK_REQUESTS_IN_FLIGHT` live requests, and every completion
 * checked against the scope, the auth epoch and the exact request that started it.
 */
function createArtworkEngine(onChange: (key: string | null, views: Views) => void) {
  let scope: Scope | null = null;

  const isCurrent = (candidate: Scope) =>
    scope === candidate && getSessionEpoch() === candidate.epoch;

  const publish = (current: Scope) => {
    const views: Record<string, PageView> = {};
    for (const [id, entry] of current.entries) {
      views[id] = { status: entry.status, retries: entry.retries, steps: entry.steps };
    }
    onChange(current.key, views);
  };

  /** Stops waiting for this entry's request, if any. Idempotent. */
  const release = (current: Scope, entry: Entry) => {
    if (!entry.active) return;
    entry.active = false;
    current.inFlight -= 1;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    entry.controller?.abort();
    entry.controller = null;
  };

  const settle = (
    current: Scope,
    entry: Entry,
    token: number,
    status: EntryStatus,
    steps: Entry['steps'],
  ) => {
    // A completion counts only for the request that is still the live one of a live scope.
    if (!isCurrent(current) || entry.token !== token || !entry.active) return;
    if (current.entries.get(entry.page.id) !== entry) return;
    release(current, entry);
    entry.status = status;
    entry.steps = steps;
    pump(current);
    publish(current);
  };

  const start = (current: Scope, entry: Entry) => {
    const token = ++entry.token;
    const controller = new AbortController();
    entry.status = 'loading';
    entry.steps = null;
    entry.active = true;
    entry.controller = controller;
    current.inFlight += 1;
    entry.timer = setTimeout(
      () => settle(current, entry, token, 'error', null),
      TRANSCRIPT_ARTWORK_DEADLINE_MS,
    );

    const { page } = entry;
    // A synchronous throw (e.g. an unavailable API) is an outage like any other.
    Promise.resolve()
      .then(() =>
        interactiveApi.getTranscriptPresentation(page.sessionId, page.request, controller.signal),
      )
      .then((raw: unknown) => {
        const checked = checkTranscriptArtwork(raw, page);
        if (!checked.ok) {
          settle(current, entry, token, 'none', null); // rejected as a whole: nothing is attached
          return;
        }
        const hasArt = checked.steps.some((step) => step !== null);
        settle(current, entry, token, hasArt ? 'ready' : 'none', checked.steps);
      })
      .catch((error: unknown) => {
        const outOfReach =
          error instanceof ApiError &&
          (error.code === 'SESSION_NOT_FOUND' ||
            error.code === 'SESSION_NOT_COMPLETED' ||
            error.status === 401);
        // The text view's own recovery owns these; the pictures just stay out of the way.
        settle(current, entry, token, outOfReach ? 'none' : 'error', null);
      });
  };

  function pump(current: Scope) {
    for (const entry of current.entries.values()) {
      if (current.inFlight >= MAX_ARTWORK_REQUESTS_IN_FLIGHT) break;
      if (entry.status === 'queued') start(current, entry);
    }
  }

  const cancelAll = (current: Scope | null) => {
    if (!current) return;
    for (const entry of current.entries.values()) release(current, entry);
    current.entries.clear();
  };

  return {
    /** Follows the transcript: a new scope drops the old one; within a scope, pages are added or removed. */
    sync(scopeKey: string | null, pages: readonly AcceptedTranscriptPage[]) {
      if (scopeKey === null) {
        cancelAll(scope);
        scope = null;
        onChange(null, EMPTY_VIEWS);
        return;
      }
      if (scope === null || scope.key !== scopeKey) {
        cancelAll(scope);
        scope = { key: scopeKey, epoch: getSessionEpoch(), entries: new Map(), inFlight: 0 };
      }
      const current = scope;
      const wanted = new Set(pages.map((page) => page.id));
      for (const [id, entry] of current.entries) {
        if (wanted.has(id)) continue;
        release(current, entry);
        current.entries.delete(id);
      }
      for (const page of pages) {
        if (current.entries.has(page.id)) continue;
        current.entries.set(page.id, {
          page,
          status: 'queued',
          retries: 0,
          steps: null,
          token: 0,
          active: false,
          controller: null,
          timer: null,
        });
      }
      pump(current);
      publish(current);
    },

    /** One manual retry of a failed page, with the same request; a no-op unless it just failed. */
    retry(pageId: string) {
      const current = scope;
      if (!current || !isCurrent(current)) return;
      const entry = current.entries.get(pageId);
      // Synchronous guard: after the first click the entry is no longer in `error`.
      if (!entry || entry.status !== 'error' || entry.retries >= MAX_ARTWORK_METADATA_RETRIES) {
        return;
      }
      entry.retries += 1;
      entry.status = 'queued';
      pump(current);
      publish(current);
    },

    dispose() {
      cancelAll(scope);
      scope = null;
    },
  };
}

/**
 * Artwork for the transcript pages already accepted, one request per page.
 *
 * Fully independent of the text: it only reads `pages`, never advances or
 * completes the transcript, and every failure leaves the text as it was. A page
 * is requested with the exact parameters of its text page and its answer is
 * attached only if it matches that text page exactly. Everything is bound to the
 * transcript's scope (session, user, auth epoch): a scope change drops the
 * rendered artwork in the same render and aborts what was in flight, and a late
 * completion for any earlier scope, request or retry is ignored.
 */
export function useTranscriptArtwork(
  scopeKey: string | null,
  pages: readonly AcceptedTranscriptPage[],
) {
  const [store, setStore] = useState<{ key: string | null; views: Views }>({
    key: null,
    views: EMPTY_VIEWS,
  });
  const [engine] = useState(() => createArtworkEngine((key, views) => setStore({ key, views })));

  useEffect(() => {
    engine.sync(scopeKey, pages);
  }, [engine, scopeKey, pages]);

  useEffect(() => () => engine.dispose(), [engine]);

  const views = scopeKey !== null && store.key === scopeKey ? store.views : EMPTY_VIEWS;

  /** The artwork state of one chapter, or `null` while there is no live scope to illustrate. */
  const forRevision = (revision: number): ChapterArtwork | null => {
    if (scopeKey === null) return null;
    const page = pages.find((candidate) => candidate.revisions.includes(revision));
    if (!page) return null;
    const view = views[page.id];
    const pack = view?.steps?.[page.revisions.indexOf(revision)] ?? null;
    let status: ChapterArtworkStatus;
    if (!view || view.status === 'queued' || view.status === 'loading') status = 'loading';
    else if (view.status === 'ready' && pack === null) status = 'none';
    else status = view.status;
    return {
      status,
      panels: status === 'ready' && pack ? pack.panels : [],
      packKey: pack ? `${pack.packId}@${pack.packVersion}` : '',
      showsNote: page.revisions[0] === revision,
      canRetry: status === 'error' && (view?.retries ?? 0) < MAX_ARTWORK_METADATA_RETRIES,
      retry: () => engine.retry(page.id),
    };
  };

  return { forRevision };
}
