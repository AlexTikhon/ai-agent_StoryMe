export type ProductMode = 'home' | 'demo';

/**
 * Browser-safe product mode. Invalid or absent values fail closed to the
 * private-family experience; build/startup validation rejects invalid
 * deployment configuration before it reaches users.
 */
export function getProductMode(): ProductMode {
  return process.env['NEXT_PUBLIC_PRODUCT_MODE'] === 'demo' ? 'demo' : 'home';
}

export function isHomeProductMode(): boolean {
  return getProductMode() === 'home';
}
