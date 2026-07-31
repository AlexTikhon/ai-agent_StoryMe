import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProductMode, isHomeProductMode } from './product-mode';

describe('product mode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults safely to home mode', () => {
    vi.stubEnv('NEXT_PUBLIC_PRODUCT_MODE', '');
    expect(getProductMode()).toBe('home');
    expect(isHomeProductMode()).toBe(true);
  });

  it('enables the existing commercial demo only explicitly', () => {
    vi.stubEnv('NEXT_PUBLIC_PRODUCT_MODE', 'demo');
    expect(getProductMode()).toBe('demo');
    expect(isHomeProductMode()).toBe(false);
  });

  it('fails closed to home for an invalid runtime value', () => {
    vi.stubEnv('NEXT_PUBLIC_PRODUCT_MODE', 'commercial');
    expect(getProductMode()).toBe('home');
  });
});
