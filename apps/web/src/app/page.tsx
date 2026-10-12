import { getApiBase } from '@/lib/api/config';
import { HomeAuthCta } from './home-auth-cta';

function getApiHealthStatus(): { url: string | null; error: string | null } {
  try {
    return { url: `${getApiBase()}/health`, error: null };
  } catch (err) {
    return { url: null, error: err instanceof Error ? err.message : 'API URL is not configured.' };
  }
}

const HOW_IT_WORKS = [
  {
    title: 'Choose a path',
    body: 'At each scene you decide what happens next, and your choices lead to different endings.',
  },
  {
    title: 'Resume later',
    body: 'Your progress is saved to your account, so you can leave and pick up at the scene where you stopped.',
  },
  {
    title: 'Reread with illustrations',
    body: 'Once you reach an ending, read the story you played again, page by page, alongside its illustrations.',
  },
] as const;

export default function HomePage() {
  // Diagnostics are for local development only; production output never names the API.
  const apiHealth = process.env.NODE_ENV === 'development' ? getApiHealthStatus() : null;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bg-base px-4 py-12">
      <div className="max-w-container-sm text-center">
        {/* Logo mark */}
        <div className="mx-auto mb-8 flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-brand shadow-brand">
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
            <path
              d="M8 6C8 4.895 8.895 4 10 4H22C23.105 4 24 4.895 24 6V34C24 35.105 23.105 36 22 36H10C8.895 36 8 35.105 8 34V6Z"
              fill="white"
              fillOpacity="0.9"
            />
            <path
              d="M24 8H28C29.105 8 30 8.895 30 10V30C30 31.105 29.105 32 28 32H24V8Z"
              fill="white"
              fillOpacity="0.5"
            />
            <path
              d="M12 12H20M12 16H20M12 20H17"
              stroke="#6535E0"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </div>

        <h1 className="mb-4 font-display text-5xl font-bold text-text-primary">StoryMe</h1>

        <p className="mb-2 text-xl text-text-secondary">
          Interactive illustrated stories you steer with your choices
        </p>

        <p className="mb-10 text-base text-text-muted">
          Pick a story, choose your path through it, and come back to it whenever you like.
        </p>

        <HomeAuthCta />

        <ol className="mt-14 grid gap-4 text-left sm:grid-cols-3">
          {HOW_IT_WORKS.map((step) => (
            <li
              key={step.title}
              className="rounded-xl border border-border-subtle bg-bg-surface p-4"
            >
              <h2 className="font-display text-base font-semibold text-text-primary">
                {step.title}
              </h2>
              <p className="mt-1 text-sm text-text-muted">{step.body}</p>
            </li>
          ))}
        </ol>

        <p className="mt-8 text-sm text-text-muted">
          Gameplay is deterministic: the same choices always lead to the same scenes. AI helps
          authors draft scenarios; it does not run the story while you play, and the illustrations
          are part of the story rather than generated on the fly.
        </p>

        {apiHealth && (
          <div className="mt-12 rounded-xl border border-border-subtle bg-bg-subtle p-4 text-sm text-text-muted">
            <p className="font-semibold text-text-secondary">Development diagnostics</p>
            <p className="mt-1">
              API:{' '}
              {apiHealth.url ? (
                <code className="rounded bg-stone-200 px-1 py-0.5 font-mono text-xs">
                  {apiHealth.url}
                </code>
              ) : (
                <span className="font-medium text-red-600">{apiHealth.error}</span>
              )}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
