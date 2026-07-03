import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ResetPasswordDto } from './reset-password.dto';

function validPayload(): Record<string, unknown> {
  return {
    token: 'raw-reset-token',
    password: 'Password1',
  };
}

async function validateDto(payload: Record<string, unknown>) {
  const dto = plainToInstance(ResetPasswordDto, payload);
  const errors = await validate(dto);
  return { dto, errors };
}

describe('ResetPasswordDto', () => {
  it('accepts a valid token and password with no errors', async () => {
    const { errors } = await validateDto(validPayload());
    expect(errors).toHaveLength(0);
  });

  it('rejects a missing token', async () => {
    const { errors } = await validateDto({ password: 'Password1' });
    expect(errors.some((e) => e.property === 'token')).toBe(true);
  });

  it('rejects a password shorter than 8 characters', async () => {
    const { errors } = await validateDto({ ...validPayload(), password: 'Pass1' });
    expect(errors.some((e) => e.property === 'password')).toBe(true);
  });

  it('rejects a password with no uppercase letter', async () => {
    const { errors } = await validateDto({ ...validPayload(), password: 'password1' });
    expect(errors.some((e) => e.property === 'password')).toBe(true);
  });

  it('rejects a password with no number', async () => {
    const { errors } = await validateDto({ ...validPayload(), password: 'Password' });
    expect(errors.some((e) => e.property === 'password')).toBe(true);
  });

  it('rejects a password longer than 72 characters', async () => {
    const { errors } = await validateDto({ ...validPayload(), password: `Aa1${'a'.repeat(70)}` });
    expect(errors.some((e) => e.property === 'password')).toBe(true);
  });
});
