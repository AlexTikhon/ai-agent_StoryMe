import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { MAX_BOOK_PAGE_COUNT, MIN_BOOK_PAGE_COUNT, SupportedLanguage } from '@book/types';

/** Trims strings before validation so whitespace-only input fails Length's min bound. Non-strings pass through for class-validator's @IsString to reject. */
function trim(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));
}

export class UpdateBookDto {
  @IsOptional()
  @trim()
  @IsString()
  @Length(1, 120)
  title?: string;

  @IsOptional()
  @trim()
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
  @trim()
  @IsString()
  @Length(1, 120)
  theme?: string;

  @IsOptional()
  @trim()
  @IsString()
  @Length(1, 300)
  educationalMessage?: string;

  @IsOptional()
  @IsInt()
  @Min(MIN_BOOK_PAGE_COUNT)
  @Max(MAX_BOOK_PAGE_COUNT)
  pageCount?: number;
}
