import { Transform } from 'class-transformer';
import { IsInt, IsString, Length, Min } from 'class-validator';

export class UpdateBookPageTextDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 2000)
  text!: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
