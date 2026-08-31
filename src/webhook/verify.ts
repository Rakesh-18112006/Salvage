/**
 * Webhook signature verification.
 *
 * Spec Phase 2: "webhook ingress with HMAC verification".
 *
 * Razorpay signs webhooks with HMAC-SHA256 over the RAW request body, using the webhook
 * secret, sent in the `x-razorpay-signature` header.
 *
 * // UNVERIFIED - confirm the header name, digest encoding (hex vs base64), and the
 * // exact bytes covered against Razorpay's webhook documentation before submission.
 * // Tracked as OPEN ITEM 7 in the README. The scheme below (hex HMAC-SHA256 over the
 * // raw body) is the conventional one and is what the local simulated sender uses, but
 * // it has not been checked against the vendor's docs, so it is not asserted as fact.
 *
 * Two things here are not negotiable regardless of what the docs say:
 *
 *   1. Verify against the RAW body bytes, never against a re-serialised object. JSON
 *      round-tripping reorders keys and changes whitespace, and the signature is over
 *      bytes, not meaning.
 *   2. Compare with a TIMING-SAFE comparison. A plain === leaks how much of the digest
 *      matched via response timing, which is enough to forge a signature byte by byte.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-razorpay-signature';

export function sign(rawBody: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifySignature(
  rawBody: string | Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (signature === undefined || signature === '') return false;

  const expected = Buffer.from(sign(rawBody, secret), 'utf8');
  const provided = Buffer.from(signature, 'utf8');

  // timingSafeEqual throws on length mismatch, which would itself be a timing signal;
  // check length first and return the same way for every wrong-length signature.
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
