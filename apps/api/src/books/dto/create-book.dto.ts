import { IsEnum, IsInt, IsString, Length, Max, Min } from 'class-validator';
import { SupportedLanguage } from '@book/types';

export class CreateBookDto {
  @IsString()
  @Length(1, 120)
  title!: string;

  @IsString()
  @Length(1, 80)
  childName!: string;

  @IsInt()
  @Min(1)
  @Max(12)
  childAge!: number;

  @IsEnum(SupportedLanguage)
  language!: SupportedLanguage;

  @IsString()
  @Length(1, 120)
  theme!: string;
}
