import { HttpException, HttpStatus } from '@nestjs/common';

export const BILLING_DISABLED_CODE = 'BILLING_DISABLED';
export const INVALID_PACKAGE_CODE = 'INVALID_PACKAGE';
export const INVALID_SIGNATURE_CODE = 'INVALID_SIGNATURE';
export const CHECKOUT_UNAVAILABLE_CODE = 'CHECKOUT_UNAVAILABLE';

/** Billing is off (STRIPE_BILLING_ENABLED=false) or misconfigured — checkout must fail without ever contacting Stripe. */
export function billingDisabledException(): HttpException {
  return new HttpException(
    {
      error: 'Billing is not available',
      message: 'Billing is not available',
      code: BILLING_DISABLED_CODE,
    },
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}

/** An unknown or unavailable packageId — never echoes the raw client-supplied value back in a way that could imply which ids are almost valid. */
export function invalidPackageException(): HttpException {
  return new HttpException(
    {
      error: 'Unknown credit package',
      message: 'Unknown credit package',
      code: INVALID_PACKAGE_CODE,
    },
    HttpStatus.BAD_REQUEST,
  );
}

/** Missing/invalid Stripe-Signature header — deliberately generic; never echoes the signature or payload. */
export function invalidSignatureException(): HttpException {
  return new HttpException(
    {
      error: 'Invalid webhook signature',
      message: 'Invalid webhook signature',
      code: INVALID_SIGNATURE_CODE,
    },
    HttpStatus.BAD_REQUEST,
  );
}

/** Stripe accepted the request but didn't return a usable Checkout Session (e.g. no hosted URL) — an upstream failure, not a client error. */
export function checkoutUnavailableException(): HttpException {
  return new HttpException(
    {
      error: 'Checkout is temporarily unavailable',
      message: 'Checkout is temporarily unavailable',
      code: CHECKOUT_UNAVAILABLE_CODE,
    },
    HttpStatus.BAD_GATEWAY,
  );
}
