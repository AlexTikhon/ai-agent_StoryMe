export interface VerificationEmailPayload {
  to: string;
  name?: string | null;
  /** Raw (unhashed) token — only ever passed to the email transport, never persisted. */
  token: string;
  verificationUrl: string;
}

export interface PasswordResetEmailPayload {
  to: string;
  name?: string | null;
  /** Raw (unhashed) token — only ever passed to the email transport, never persisted. */
  token: string;
  resetUrl: string;
}

/**
 * Storage-style boundary for outbound transactional email, mirroring
 * PdfStorage/ImageAssetStorage: callers (AuthService) depend only on this
 * interface, so a real provider (Resend/SES/etc.) is a drop-in swap for
 * ConsoleEmailService later without touching AuthService.
 */
export interface EmailService {
  sendVerificationEmail(payload: VerificationEmailPayload): Promise<void>;
  sendPasswordResetEmail(payload: PasswordResetEmailPayload): Promise<void>;
}

export const EMAIL_SERVICE_TOKEN = 'EMAIL_SERVICE';
