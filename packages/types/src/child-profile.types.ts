/** Safe public projection of a reusable child profile. Internal asset/deletion fields stay server-side. */
export interface ChildProfileDto {
  id: string;
  name: string;
  age: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChildProfilesPageDto {
  items: ChildProfileDto[];
  page: number;
  limit: number;
  total: number;
}

export interface CreateChildProfileInput {
  name: string;
  age: number;
}

export type UpdateChildProfileInput = Partial<CreateChildProfileInput>;
