/**
 * Idempotency keys.
 *
 * Spec Phase 2: "Every outbound call carries sha256(case_id, attempt_no) as its
 * idempotency key."
 *
 * The key is derived, never generated. That is the entire point: a worker that crashes
 * and is replaced recomputes the identical key from the identical inputs, so its replay
 * collides with the original instead of becoming a second charge. A random UUID minted
 * at call time would give a fresh key on every replay and guarantee double charges under
 * exactly the failure this phase exists to survive.
 */
import { createHash } from 'node:crypto';

export function attemptIdempotencyKey(caseId: string, attemptNo: number): string {
  if (!Number.isInteger(attemptNo) || attemptNo <= 0) {
    throw new Error(`attemptNo must be a positive integer, got ${attemptNo}`);
  }
  return createHash('sha256').update(`${caseId}:${attemptNo}`, 'utf8').digest('hex');
}

/** Notifications get the same treatment, keyed by what makes the message unique. */
export function notificationIdempotencyKey(
  caseId: string,
  templateId: string,
  sequence: number,
): string {
  return createHash('sha256')
    .update(`${caseId}:${templateId}:${sequence}`, 'utf8')
    .digest('hex');
}
