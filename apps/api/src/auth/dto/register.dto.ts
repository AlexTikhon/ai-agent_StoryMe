import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';

function normalizeEmail(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );
}

function trim(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );
}

export class RegisterDto {
  @normalizeEmail()
  @IsEmail()
  email!: string;

  // 72-char cap matches bcrypt's input limit, so nothing is silently truncated.
  @IsString()
  @Length(8, 72)
  @Matches(/[A-Z]/, { message: 'password must contain at least one uppercase letter' })
  @Matches(/[0-9]/, { message: 'password must contain at least one number' })
  password!: string;

  @IsOptional()
  @trim()
  @IsString()
  @Length(1, 120)
  name?: string;
}
