/**
 * Executable spec for the PaymentIntent state machine (issue #36).
 *
 * This graph is the single source of truth for allowed transitions.
 * Anything not declared here is rejected. Status names match the Prisma
 * `PaymentIntentStatus` enum and must not be renamed.
 */
export const PAYMENT_INTENT_STATUSES = [
  'PENDING',
  'SUBMITTED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
] as const;

export type PaymentIntentStatusName =
  (typeof PAYMENT_INTENT_STATUSES)[number];

/** Terminal statuses cannot be abandoned. */
export const TERMINAL_STATUSES = [
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
] as const satisfies readonly PaymentIntentStatusName[];

export type TerminalPaymentIntentStatus = (typeof TERMINAL_STATUSES)[number];

/**
 * Declared transition graph: from each status, the set of allowed next statuses.
 * Deny-by-default — undeclared edges are invalid.
 */
export const PAYMENT_INTENT_TRANSITIONS: Record<
  PaymentIntentStatusName,
  readonly PaymentIntentStatusName[]
> = {
  PENDING: ['SUBMITTED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  SUBMITTED: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};

/** Reaching SUCCEEDED always requires an on-chain transaction reference. */
export const SUCCESS_REQUIRES_TX_HASH = true as const;
