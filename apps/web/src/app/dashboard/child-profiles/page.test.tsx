import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { childProfilesApi } from '@/lib/api/child-profiles';
import ChildProfilesPage from './page';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('@/lib/api/child-profiles', () => ({
  childProfilesApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}));

const profile = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Mia',
  age: 5,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

describe('ChildProfilesPage', () => {
  beforeEach(() => {
    vi.mocked(childProfilesApi.list).mockResolvedValue({
      items: [profile],
      page: 1,
      limit: 20,
      total: 1,
    });
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    vi.stubGlobal('alert', vi.fn());
  });

  afterEach(() => vi.unstubAllGlobals());

  it('loads profiles and creates a normalized profile', async () => {
    const user = userEvent.setup();
    vi.mocked(childProfilesApi.create).mockResolvedValue({
      ...profile,
      id: 'profile-2',
      name: 'Noah',
    });
    render(<ChildProfilesPage />);
    await screen.findByText('Mia');

    await user.type(screen.getByLabelText("Child's name"), '  Noah  ');
    await user.clear(screen.getByLabelText('Age'));
    await user.type(screen.getByLabelText('Age'), '6');
    await user.click(screen.getByRole('button', { name: 'Add profile' }));

    await waitFor(() =>
      expect(childProfilesApi.create).toHaveBeenCalledWith({ name: 'Noah', age: 6 }),
    );
  });

  it('edits and soft-deletes through the management controls', async () => {
    const user = userEvent.setup();
    vi.mocked(childProfilesApi.update).mockResolvedValue({ ...profile, name: 'Mila', age: 6 });
    vi.mocked(childProfilesApi.remove).mockResolvedValue();
    render(<ChildProfilesPage />);
    await screen.findByText('Mia');

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText("Child's name"));
    await user.type(screen.getByLabelText("Child's name"), 'Mila');
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(screen.getByText('Mila')).toBeDefined());
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(childProfilesApi.remove).toHaveBeenCalledWith(profile.id));
    expect(screen.queryByText('Mila')).toBeNull();
  });
});
