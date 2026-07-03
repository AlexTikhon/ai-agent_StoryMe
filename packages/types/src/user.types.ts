/** Mirrors the UserRole enum in schema.prisma. */
export enum UserRole {
  User = 'user',
  Admin = 'admin',
}

/** API-facing shape of a User. */
export interface UserDto {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  emailVerified: boolean;
  createdAt: string;
  updatedAt: string;
}
