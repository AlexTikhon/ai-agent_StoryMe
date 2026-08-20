import type { IllustrationPlan, PagePlan, StoryPlan } from '@book/types';
import { IllustrationPlanDetail } from './book-layout-section';

export interface StoryDiagnosticsProps {
  show: boolean;
  storyPlan: StoryPlan | null;
  pages: PagePlan[] | undefined;
  draftPages: PagePlan[] | undefined;
  illustrationPages: PagePlan[] | undefined;
}

export function StoryDiagnostics({
  show: showDeveloperDiagnostics,
  storyPlan,
  pages,
  draftPages,
  illustrationPages,
}: StoryDiagnosticsProps) {
  return (
    <>
      {showDeveloperDiagnostics && storyPlan && (
        <div className="mb-6 rounded-xl border border-violet-100 bg-violet-50 p-4">
          <h2 className="mb-1 font-display text-base font-semibold text-violet-800">
            Story plan is ready
          </h2>
          <p className="mb-1 text-sm font-medium text-violet-700">{storyPlan.title}</p>
          <p className="mb-3 text-xs text-violet-600">{storyPlan.educationalMessage}</p>
          <ul className="space-y-1.5">
            {storyPlan.chapters.map((ch) => (
              <li key={ch.chapterNumber} className="text-sm">
                <span className="font-medium text-text-primary">{ch.title}</span>
                <span className="text-text-muted"> — {ch.summary}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {showDeveloperDiagnostics && pages && (
        <div className="mb-6 rounded-xl border border-indigo-100 bg-indigo-50 p-4">
          <h2 className="mb-3 font-display text-base font-semibold text-indigo-800">
            Page plan is ready
          </h2>
          <ul className="space-y-3">
            {pages.map((page) => (
              <li
                key={page.pageNumber}
                className="rounded-lg border border-indigo-100 bg-white p-3 text-sm"
              >
                <div className="mb-1 flex items-center gap-2">
                  <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">
                    Page {page.pageNumber}
                  </span>
                  <span className="text-xs text-text-muted">Chapter {page.chapterIndex + 1}</span>
                </div>
                <p className="mb-0.5 font-medium text-text-primary">{page.title}</p>
                <p className="mb-0.5 text-text-secondary">{page.sceneDescription}</p>
                <p className="mb-0.5 text-text-muted italic">{page.narration}</p>
                <p className="mb-0.5 text-xs text-indigo-600">
                  <span className="font-medium">Illustration:</span> {page.illustrationPrompt}
                </p>
                <p className="text-xs text-indigo-500">
                  <span className="font-medium">Learning goal:</span> {page.learningGoal}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {showDeveloperDiagnostics && draftPages && draftPages.length > 0 && (
        <div className="mb-6 rounded-xl border border-emerald-100 bg-emerald-50 p-4">
          <h2 className="mb-3 font-display text-base font-semibold text-emerald-800">
            Story draft is ready
          </h2>
          <ul className="space-y-3">
            {draftPages.map((page) => (
              <li
                key={page.pageNumber}
                className="rounded-lg border border-emerald-100 bg-white p-3 text-sm"
              >
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                    Page {page.pageNumber}
                  </span>
                  <span className="font-medium text-text-primary">{page.title}</span>
                </div>
                <p className="leading-relaxed text-text-secondary">{page.storyText}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {showDeveloperDiagnostics && illustrationPages && illustrationPages.length > 0 && (
        <div className="mb-6 rounded-xl border border-amber-100 bg-amber-50 p-4">
          <h2 className="mb-3 font-display text-base font-semibold text-amber-800">
            Illustration plan is ready
          </h2>
          <ul className="space-y-3">
            {illustrationPages.map((page) => (
              <li
                key={page.pageNumber}
                className="rounded-lg border border-amber-100 bg-white p-3 text-sm"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                    Page {page.pageNumber}
                  </span>
                </div>
                <IllustrationPlanDetail illust={page.illustration as IllustrationPlan} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
