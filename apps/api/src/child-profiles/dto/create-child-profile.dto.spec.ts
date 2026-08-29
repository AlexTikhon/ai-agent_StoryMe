import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreateChildProfileDto } from './create-child-profile.dto';

describe('CreateChildProfileDto', () => {
  it('normalizes a valid name and age', async () => {
    const dto = plainToInstance(CreateChildProfileDto, { name: '  Mia  ', age: 5 });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.name).toBe('Mia');
  });

  it('rejects blank/oversized names and ages outside the book range', async () => {
    for (const payload of [
      { name: '   ', age: 5 },
      { name: 'x'.repeat(81), age: 5 },
      { name: 'Mia', age: 0 },
      { name: 'Mia', age: 13 },
    ]) {
      expect(await validate(plainToInstance(CreateChildProfileDto, payload))).not.toHaveLength(0);
    }
  });
});
