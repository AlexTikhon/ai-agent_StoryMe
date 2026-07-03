import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length } from 'class-validator';

function normalizeEmail(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );
}

export class LoginDto {
  @normalizeEmail()
  @IsEmail()
  email!: string;

  @IsString()
  @Length(1, 200)
  password!: string;
}
