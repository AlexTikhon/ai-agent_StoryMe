import { IsUUID } from 'class-validator';

/**
 * Exact target confirmation makes permanent deletion materially distinct
 * from the legacy empty-body soft-delete endpoint.
 */
export class RequestBookHardDeleteDto {
  @IsUUID()
  confirmation!: string;
}
