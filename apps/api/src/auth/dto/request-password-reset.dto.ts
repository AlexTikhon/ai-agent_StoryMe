import { Transform } from 'class-transformer';
import { IsEmail } from 'class-validator';

function normalizeEmail(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );
}

export class RequestPasswordResetDto {
  @normalizeEmail()
  @IsEmail()
  email!: string;
}
