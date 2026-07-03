import { IsString, Length, Matches } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  @Length(1, 256)
  token!: string;

  // Same policy as RegisterDto — 72-char cap matches bcrypt's input limit.
  @IsString()
  @Length(8, 72)
  @Matches(/[A-Z]/, { message: 'password must contain at least one uppercase letter' })
  @Matches(/[0-9]/, { message: 'password must contain at least one number' })
  password!: string;
}
