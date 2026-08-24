import { ConflictException } from '@nestjs/common';

/**
 * Pre-BlindPay KYC states owned by this service, plus BlindPay's own statuses
 * once the receiver exists upstream (`enable()` handoff).
 */
export const OWN_KYC_STATES = [
  'inactive',
  'pending_review',
  'pending_user',
] as const;

/** BlindPay KYC statuses mirrored after the receiver is created upstream. */
export const BLINDPAY_KYC_STATES = [
  'verifying',
  'approved',
  'rejected',
] as const;

export type OwnKycState = (typeof OWN_KYC_STATES)[number];
export type BlindpayKycState = (typeof BLINDPAY_KYC_STATES)[number];
export type KycState = OwnKycState | BlindpayKycState;

/**
 * Explicit transition table for receiver `kycStatus`.
 *
 *   inactive       → pending_review  (KYC data uploaded via local update)
 *   pending_review → pending_user    (owner/admin approve)
 *   pending_user   → pending_review  (local KYC edit after approval → re-review)
 *   pending_user   → verifying|…     (enable() creates the BlindPay receiver)
 *   verifying      → approved|rejected (BlindPay-owned; listed for completeness)
 */
export const ALLOWED_TRANSITIONS: Record<KycState, readonly KycState[]> = {
  inactive: ['pending_review'],
  pending_review: ['pending_user'],
  pending_user: ['pending_review', 'verifying', 'approved', 'rejected'],
  verifying: ['approved', 'rejected'],
  approved: [],
  rejected: [],
};

/**
 * Asserts `from → to` is declared in {@link ALLOWED_TRANSITIONS}.
 * Throws {@link ConflictException} (409) naming both states on violation.
 */
export function assertTransition(
  from: string | null | undefined,
  to: KycState,
): void {
  const source = from ?? 'unknown';
  const allowed = ALLOWED_TRANSITIONS[source as KycState];
  if (!allowed?.includes(to)) {
    throw new ConflictException(
      `Cannot move receiver from '${source}' to '${to}'`,
    );
  }
}
