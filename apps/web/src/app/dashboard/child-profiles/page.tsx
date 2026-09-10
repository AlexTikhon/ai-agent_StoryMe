'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ChildProfileDto } from '@book/types';
import { childProfilesApi } from '@/lib/api/child-profiles';

const inputCls =
  'rounded-lg border border-border-default bg-white px-3 py-2 text-sm text-text-primary focus:border-violet-600 focus:outline-none focus:ring-1 focus:ring-violet-600';

export default function ChildProfilesPage() {
  const [profiles, setProfiles] = useState<ChildProfileDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [age, setAge] = useState(4);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadProfiles = useCallback(async () => {
    setLoadError(null);
    try {
      const result = await childProfilesApi.list();
      setProfiles(result.items);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Failed to load child profiles');
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setAge(4);
    setFormError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!normalizedName) {
      setFormError("Child's name is required");
      return;
    }
    if (!Number.isInteger(age) || age < 1 || age > 12) {
      setFormError('Age must be between 1 and 12');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const saved = editingId
        ? await childProfilesApi.update(editingId, { name: normalizedName, age })
        : await childProfilesApi.create({ name: normalizedName, age });
      setProfiles((current) => {
        const withoutSaved = (current ?? []).filter((profile) => profile.id !== saved.id);
        return [saved, ...withoutSaved];
      });
      resetForm();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Failed to save child profile');
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (profile: ChildProfileDto) => {
    setEditingId(profile.id);
    setName(profile.name);
    setAge(profile.age);
    setFormError(null);
  };

  const remove = async (profile: ChildProfileDto) => {
    if (
      !window.confirm(
        `Delete ${profile.name}'s saved profile? Existing books keep their copied child details.`,
      )
    ) {
      return;
    }
    setDeletingId(profile.id);
    try {
      await childProfilesApi.remove(profile.id);
      setProfiles((current) => current?.filter((item) => item.id !== profile.id) ?? []);
      if (editingId === profile.id) resetForm();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to delete child profile');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <main className="min-h-dvh bg-bg-base px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <Link
          href="/dashboard"
          className="mb-8 inline-flex items-center gap-1 text-sm font-medium text-text-muted hover:text-text-primary"
        >
          ← My Book Drafts
        </Link>
        <h1 className="mb-2 font-display text-3xl font-bold text-text-primary">Child profiles</h1>
        <p className="mb-6 text-sm leading-relaxed text-text-muted">
          Save name and age for future books. Editing or deleting a profile never rewrites an
          existing book or generation.
        </p>

        <form
          onSubmit={(event) => void submit(event)}
          className="mb-8 rounded-2xl border border-border-default bg-bg-surface p-6 shadow-sm"
        >
          <h2 className="mb-4 font-display text-xl font-semibold text-text-primary">
            {editingId ? 'Edit profile' : 'Add a child profile'}
          </h2>
          {formError && (
            <p
              role="alert"
              className="mb-4 rounded-lg bg-danger-light px-4 py-3 text-sm text-danger-base"
            >
              {formError}
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text-secondary">Child&apos;s name</span>
              <input
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text-secondary">Age</span>
              <input
                required
                type="number"
                min={1}
                max={12}
                value={age}
                onChange={(event) => setAge(Number(event.target.value))}
                className={inputCls}
              />
            </label>
          </div>
          <div className="mt-5 flex gap-3">
            <button
              type="submit"
              disabled={saving || (!editingId && (profiles?.length ?? 0) >= 20)}
              className="inline-flex h-10 items-center rounded-xl bg-violet-600 px-5 text-sm font-semibold text-white shadow-brand hover:bg-violet-500 disabled:opacity-60"
            >
              {saving ? 'Saving…' : editingId ? 'Save profile' : 'Add profile'}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                className="inline-flex h-10 items-center rounded-xl border border-border-default px-5 text-sm font-semibold text-text-primary hover:bg-stone-100"
              >
                Cancel
              </button>
            )}
          </div>
          {(profiles?.length ?? 0) >= 20 && (
            <p className="mt-3 text-sm text-text-muted">
              The limit of 20 active profiles is reached.
            </p>
          )}
        </form>

        {profiles === null && !loadError && (
          <p className="text-sm text-text-muted">Loading profiles…</p>
        )}
        {loadError && (
          <div role="alert" className="rounded-xl border border-danger-base/20 bg-danger-light p-4">
            <p className="text-sm text-danger-base">{loadError}</p>
            <button
              onClick={() => void loadProfiles()}
              className="mt-2 text-sm font-semibold underline"
            >
              Retry
            </button>
          </div>
        )}
        {profiles?.length === 0 && (
          <p className="rounded-xl border border-border-subtle bg-bg-surface p-5 text-sm text-text-muted">
            No saved profiles yet. Add one above, or continue entering child details manually when
            creating a book.
          </p>
        )}
        {profiles && profiles.length > 0 && (
          <ul aria-label="Saved child profiles" className="space-y-3">
            {profiles.map((profile) => (
              <li
                key={profile.id}
                className="flex items-center justify-between gap-4 rounded-xl border border-border-subtle bg-bg-surface p-4"
              >
                <div>
                  <p className="font-semibold text-text-primary">{profile.name}</p>
                  <p className="text-sm text-text-muted">Age {profile.age}</p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => startEdit(profile)}
                    className="rounded-lg border border-border-default px-3 py-2 text-sm font-semibold text-text-secondary"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={deletingId === profile.id}
                    onClick={() => void remove(profile)}
                    className="rounded-lg px-3 py-2 text-sm font-semibold text-danger-base disabled:opacity-60"
                  >
                    {deletingId === profile.id ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
