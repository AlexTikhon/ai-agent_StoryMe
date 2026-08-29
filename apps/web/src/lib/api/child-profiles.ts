import type {
  ChildProfileDto,
  ChildProfilesPageDto,
  CreateChildProfileInput,
  UpdateChildProfileInput,
} from '@book/types';
import { apiFetch } from './client';

export const childProfilesApi = {
  list: (page = 1, limit = 20): Promise<ChildProfilesPageDto> =>
    apiFetch(`/child-profiles?page=${page}&limit=${limit}`),

  get: (id: string): Promise<ChildProfileDto> => apiFetch(`/child-profiles/${id}`),

  create: (data: CreateChildProfileInput): Promise<ChildProfileDto> =>
    apiFetch('/child-profiles', { method: 'POST', body: JSON.stringify(data) }),

  update: (id: string, data: UpdateChildProfileInput): Promise<ChildProfileDto> =>
    apiFetch(`/child-profiles/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  remove: (id: string): Promise<void> => apiFetch(`/child-profiles/${id}`, { method: 'DELETE' }),
};
