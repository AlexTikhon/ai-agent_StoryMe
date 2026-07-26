import { IsInt, Min } from 'class-validator';

export class CreatePageImageQuoteDto {
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
