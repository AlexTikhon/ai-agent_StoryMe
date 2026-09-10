import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

function trim(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );
}

export class UpdateChildProfileDto {
  @IsOptional()
  @trim()
  @IsString()
  @Length(1, 80)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  age?: number;
}
