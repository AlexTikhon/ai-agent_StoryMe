import { afterEach, describe, expect, it, vi } from 'vitest';
import { childProfilesApi } from './child-profiles';

function ok(body?: unknown, status = 200): Response {
  return {
    ok: true,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('childProfilesApi', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the owner-scoped profile routes and JSON methods', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ items: [], page: 1, limit: 20, total: 0 }))
      .mockResolvedValueOnce(ok({ id: 'p-1', name: 'Mia', age: 5 }))
      .mockResolvedValueOnce(ok({ id: 'p-1', name: 'Mila', age: 6 }))
      .mockResolvedValueOnce(ok(undefined, 204));
    vi.stubGlobal('fetch', fetchMock);

    await childProfilesApi.list();
    await childProfilesApi.create({ name: 'Mia', age: 5 });
    await childProfilesApi.update('p-1', { name: 'Mila', age: 6 });
    await childProfilesApi.remove('p-1');

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/child-profiles?page=1&limit=20');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: 'PATCH' });
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ method: 'DELETE' });
  });
});
