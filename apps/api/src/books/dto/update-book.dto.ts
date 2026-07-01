import { IsEnum, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { SupportedLanguage } from '@book/types';

export class UpdateBookDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  childName?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  childAge?: number;

  @IsOptional()
  @IsEnum(SupportedLanguage)
  language?: SupportedLanguage;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  theme?: string;
}
