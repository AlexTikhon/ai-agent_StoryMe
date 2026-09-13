import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { UpdateBookDto } from './update-book.dto';

describe('UpdateBookDto nullable draft semantics', () => {
  it('accepts explicit null to clear nullable draft columns', async () => {
    const dto = plainToInstance(UpdateBookDto, {
      childProfileId: null,
      title: null,
      childName: null,
      childAge: null,
      language: null,
      theme: null,
      educationalMessage: null,
      pageCount: null,
    });

    expect(await validate(dto)).toEqual([]);
    expect(dto).toMatchObject({
      childProfileId: null,
      educationalMessage: null,
      pageCount: null,
    });
  });

  it('still validates every non-null supplied value', async () => {
    const dto = plainToInstance(UpdateBookDto, {
      title: '   ',
      childAge: 99,
      educationalMessage: 'x'.repeat(301),
    });

    const errors = await validate(dto);
    expect(errors.map(({ property }) => property)).toEqual(
      expect.arrayContaining(['title', 'childAge', 'educationalMessage']),
    );
  });
});
