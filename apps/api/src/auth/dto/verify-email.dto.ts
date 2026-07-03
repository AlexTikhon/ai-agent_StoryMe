import { IsString, Length } from 'class-validator';

export class VerifyEmailDto {
  @IsString()
  @Length(1, 256)
  token!: string;
}
