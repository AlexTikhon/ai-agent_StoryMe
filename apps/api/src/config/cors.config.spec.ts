import { describe, expect, it } from 'vitest';
import { buildCorsOptions } from './cors.config';

describe('buildCorsOptions', () => {
  it('allows clients to send and read the request correlation header', () => {
    const options = buildCorsOptions({
      ALLOWED_ORIGINS: 'https://storyme.example',
    });

    expect(options.allowedHeaders).toContain('X-Request-ID');
    expect(options.exposedHeaders).toContain('X-Request-ID');
  });
});
