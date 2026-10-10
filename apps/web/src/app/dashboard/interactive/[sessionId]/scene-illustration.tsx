'use client';

import { useState } from 'react';
import type { InteractivePresentationPanelDto, InteractiveSessionViewDto } from '@book/types';
import {
  MAX_ILLUSTRATION_RETRIES,
  useScenePresentation,
  type ScenePresentation,
} from './use-scene-presentation';

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300';

/** Space reserved while artwork is on its way: every published panel is 3:2. */
const RESERVED_ASPECT = '3 / 2';

function Placeholder({ aspect }: { aspect: string }) {
  return (
    <div
      aria-hidden="true"
      data-testid="illustration-placeholder"
      style={{ aspectRatio: aspect }}
      className="w-full animate-pulse rounded-xl border border-stone-800 bg-stone-900/80 motion-reduce:animate-none"
    />
  );
}

function UnavailableNote({ onRetry }: { onRetry: (() => void) | null }) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-stone-500">
      <span>The illustration isn&apos;t available right now. The story continues in text.</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className={`rounded font-medium text-stone-300 underline hover:text-stone-100 ${FOCUS_RING}`}
        >
          Reload illustration
        </button>
      )}
    </p>
  );
}

/**
 * Renders the panels of one scene. Mounted per scene scope (keyed by the
 * caller), so image-failure state can never carry over to another scene.
 */
function Panels({ panels }: { panels: InteractivePresentationPanelDto[] }) {
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [imageRetries, setImageRetries] = useState(0);

  const visible = panels.filter((panel) => !failed.has(panel.id));
  if (visible.length === 0) {
    const canRetry = imageRetries < MAX_ILLUSTRATION_RETRIES;
    return (
      <UnavailableNote
        onRetry={
          canRetry
            ? () => {
                setImageRetries((n) => n + 1);
                setFailed(new Set());
              }
            : null
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      {visible.map((panel) => (
        <figure
          key={`${panel.id}:${imageRetries}`}
          style={{ aspectRatio: `${panel.width} / ${panel.height}` }}
          className="relative w-full overflow-hidden rounded-xl border border-stone-800 bg-stone-900"
        >
          {/* A plain <img>: these are small same-origin SVGs, which next/image would not optimise. */}
          <img
            src={panel.src}
            alt={panel.alt}
            width={panel.width}
            height={panel.height}
            ref={(img) => {
              // A cached image can finish before the load handler is observed.
              if (img?.complete && img.naturalWidth > 0 && !loaded.has(panel.id)) {
                setLoaded((current) => new Set(current).add(panel.id));
              }
            }}
            decoding="async"
            draggable={false}
            onLoad={() => setLoaded((current) => new Set(current).add(panel.id))}
            onError={() => setFailed((current) => new Set(current).add(panel.id))}
            className={`h-full w-full object-cover transition-opacity duration-300 motion-reduce:transition-none ${
              loaded.has(panel.id) ? 'opacity-100' : 'opacity-0'
            }`}
          />
        </figure>
      ))}
    </div>
  );
}

export function IllustrationSlot({ presentation }: { presentation: ScenePresentation }) {
  switch (presentation.status) {
    case 'idle':
    case 'none':
      return null;
    case 'loading':
      return <Placeholder aspect={RESERVED_ASPECT} />;
    case 'error':
      return <UnavailableNote onRetry={presentation.canRetry ? presentation.retry : null} />;
    case 'ready':
      return <Panels key={presentation.scopeKey} panels={presentation.panels} />;
  }
}

/**
 * Artwork for the displayed scene. Reads metadata separately from story state
 * and never affects choices: every failure collapses to the plain text reader.
 */
export function SceneIllustration({ view }: { view: InteractiveSessionViewDto | null }) {
  const presentation = useScenePresentation(view);
  return (
    <div data-testid="scene-illustration" data-scene-id={view?.scene.id ?? ''}>
      <IllustrationSlot presentation={presentation} />
    </div>
  );
}
