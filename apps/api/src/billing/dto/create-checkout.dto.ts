import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Body of POST /api/billing/checkout — the client supplies only a stable public package id, never a Price ID, credit amount, currency, or monetary amount. */
export class CreateCheckoutDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  packageId!: string;
}
