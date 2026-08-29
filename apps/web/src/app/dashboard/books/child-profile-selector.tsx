'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ChildProfileDto } from '@book/types';
import { childProfilesApi } from '@/lib/api/child-profiles';

interface ChildProfileSelectorProps {
  childProfileId: string | null;
  onSelect: (profile: ChildProfileDto | null) => void;
}

export function ChildProfileSelector({ childProfileId, onSelect }: ChildProfileSelectorProps) {
  const [profiles, setProfiles] = useState<ChildProfileDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    childProfilesApi
      .list()
      .then((result) => {
        if (active) setProfiles(result.items);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : 'Saved profiles are unavailable');
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const selectedIsDeleted =
    profiles !== null &&
    childProfileId !== null &&
    !profiles.some((profile) => profile.id === childProfileId);

  return (
    <div className="sm:col-span-2">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <label htmlFor="child-profile" className="text-sm font-medium text-text-secondary">
          Saved child profile
        </label>
        <Link
          href="/dashboard/child-profiles"
          className="text-xs font-semibold text-violet-700 hover:text-violet-600"
        >
          Manage profiles
        </Link>
      </div>
      <select
        id="child-profile"
        value={selectedIsDeleted ? '__deleted__' : (childProfileId ?? '')}
        disabled={profiles === null && !error}
        onChange={(event) => {
          const profile = profiles?.find((item) => item.id === event.target.value) ?? null;
          onSelect(profile);
        }}
        className="w-full rounded-lg border border-border-default bg-white px-3 py-2 text-sm text-text-primary focus:border-violet-600 focus:outline-none focus:ring-1 focus:ring-violet-600 disabled:opacity-60"
      >
        <option value="">Enter child details manually</option>
        {selectedIsDeleted && (
          <option value="__deleted__" disabled>
            Previously selected profile was deleted
          </option>
        )}
        {profiles?.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}, age {profile.age}
          </option>
        ))}
      </select>
      {profiles === null && !error && (
        <p className="mt-1.5 text-xs text-text-muted">Loading saved profiles…</p>
      )}
      {profiles?.length === 0 && !selectedIsDeleted && (
        <p className="mt-1.5 text-xs text-text-muted">
          No saved profiles yet. Manual details work exactly as before.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-danger-base">
          {error}. You can continue with manual details.
        </p>
      )}
      {selectedIsDeleted && (
        <p role="status" className="mt-1.5 text-xs text-amber-800">
          This saved profile was deleted. The book&apos;s copied name and age are preserved; choose
          manual entry or another profile before saving if you want to change the selection.
        </p>
      )}
      <p className="mt-1.5 text-xs leading-relaxed text-text-muted">
        Selecting a profile copies its current name and age into this book. Later profile edits do
        not rewrite existing books or generations.
      </p>
    </div>
  );
}
