import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateBookDto } from './create-book.dto';

function validPayload(): Record<string, unknown> {
  return {
    title: 'The Adventures of Mia',
    childName: 'Mia',
    childAge: 5,
    language: 'en',
    theme: 'friendship',
  };
}

async function validateDto(payload: Record<string, unknown>) {
  const dto = plainToInstance(CreateBookDto, payload);
  const errors = await validate(dto);
  return { dto, errors };
}

describe('CreateBookDto', () => {
  it('accepts a valid minimal payload with no errors', async () => {
    const { errors } = await validateDto(validPayload());
    expect(errors).toHaveLength(0);
  });

  it('trims childName, theme, and title before validation', async () => {
    const { dto, errors } = await validateDto({
      ...validPayload(),
      childName: '  Mia  ',
      theme: '  friendship  ',
      title: '  Mia’s Story  ',
    });
    expect(errors).toHaveLength(0);
    expect(dto.childName).toBe('Mia');
    expect(dto.theme).toBe('friendship');
    expect(dto.title).toBe('Mia’s Story');
  });

  it('rejects an empty childName', async () => {
    const { errors } = await validateDto({ ...validPayload(), childName: '' });
    expect(errors.some((e) => e.property === 'childName')).toBe(true);
  });

  it('rejects a whitespace-only childName', async () => {
    const { errors } = await validateDto({ ...validPayload(), childName: '   ' });
    expect(errors.some((e) => e.property === 'childName')).toBe(true);
  });

  it('rejects a whitespace-only title', async () => {
    const { errors } = await validateDto({ ...validPayload(), title: '   ' });
    expect(errors.some((e) => e.property === 'title')).toBe(true);
  });

  it('rejects a title longer than 120 characters', async () => {
    const { errors } = await validateDto({ ...validPayload(), title: 'a'.repeat(121) });
    expect(errors.some((e) => e.property === 'title')).toBe(true);
  });

  it('rejects a whitespace-only theme', async () => {
    const { errors } = await validateDto({ ...validPayload(), theme: '   ' });
    expect(errors.some((e) => e.property === 'theme')).toBe(true);
  });

  it('rejects a childName longer than 80 characters', async () => {
    const { errors } = await validateDto({ ...validPayload(), childName: 'a'.repeat(81) });
    expect(errors.some((e) => e.property === 'childName')).toBe(true);
  });

  it('rejects a theme longer than 120 characters', async () => {
    const { errors } = await validateDto({ ...validPayload(), theme: 'a'.repeat(121) });
    expect(errors.some((e) => e.property === 'theme')).toBe(true);
  });

  it('rejects an educationalMessage longer than 300 characters', async () => {
    const { errors } = await validateDto({
      ...validPayload(),
      educationalMessage: 'a'.repeat(301),
    });
    expect(errors.some((e) => e.property === 'educationalMessage')).toBe(true);
  });

  it('rejects a whitespace-only educationalMessage', async () => {
    const { errors } = await validateDto({ ...validPayload(), educationalMessage: '   ' });
    expect(errors.some((e) => e.property === 'educationalMessage')).toBe(true);
  });

  it('accepts a book with no educationalMessage (optional)', async () => {
    const { errors } = await validateDto(validPayload());
    expect(errors).toHaveLength(0);
  });

  it('trims educationalMessage before validation', async () => {
    const { dto, errors } = await validateDto({
      ...validPayload(),
      educationalMessage: '  Kindness matters  ',
    });
    expect(errors).toHaveLength(0);
    expect(dto.educationalMessage).toBe('Kindness matters');
  });

  it('accepts a full payload with both pageCount and educationalMessage', async () => {
    const { errors } = await validateDto({
      ...validPayload(),
      pageCount: 10,
      educationalMessage: 'Kindness matters',
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts pageCount within [4, 12]', async () => {
    for (const pageCount of [4, 6, 12]) {
      const { errors } = await validateDto({ ...validPayload(), pageCount });
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects pageCount below the minimum of 4', async () => {
    const { errors } = await validateDto({ ...validPayload(), pageCount: 3 });
    expect(errors.some((e) => e.property === 'pageCount')).toBe(true);
  });

  it('rejects pageCount above the maximum of 12', async () => {
    const { errors } = await validateDto({ ...validPayload(), pageCount: 13 });
    expect(errors.some((e) => e.property === 'pageCount')).toBe(true);
  });

  it('rejects a non-integer pageCount', async () => {
    const { errors } = await validateDto({ ...validPayload(), pageCount: 6.5 });
    expect(errors.some((e) => e.property === 'pageCount')).toBe(true);
  });

  it('accepts a book with no pageCount (optional)', async () => {
    const { errors } = await validateDto(validPayload());
    expect(errors).toHaveLength(0);
  });

  it('accepts a book with no language (optional, defaulted by BooksService)', async () => {
    const { errors } = await validateDto({ ...validPayload(), language: undefined });
    expect(errors).toHaveLength(0);
  });

  it('rejects an unsupported language', async () => {
    const { errors } = await validateDto({ ...validPayload(), language: 'de' });
    expect(errors.some((e) => e.property === 'language')).toBe(true);
  });

  it('rejects childAge outside [1, 12]', async () => {
    const tooYoung = await validateDto({ ...validPayload(), childAge: 0 });
    const tooOld = await validateDto({ ...validPayload(), childAge: 13 });
    expect(tooYoung.errors.some((e) => e.property === 'childAge')).toBe(true);
    expect(tooOld.errors.some((e) => e.property === 'childAge')).toBe(true);
  });
});
