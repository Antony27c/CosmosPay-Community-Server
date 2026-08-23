import type { SwapStatus } from '../../generated/prisma/client';

/**
 * Swap state machine (issue #29).
 *
 * Submit and the settlement observer both write the same row. Terminal webhook
 * events must fire only for the writer that won the status transition — a late
 * FAILED must not overwrite SUCCEEDED, and the two paths must not each mint
 * their own `evt_` id for the same (swap, event type).
 */
export const SWAP_STATUSES = [
  'PENDING',
  'SUBMITTED',
  'SUCCEEDED',
  'FAILED',
  'EXPIRED',
] as const satisfies readonly SwapStatus[];

/**
 * Statuses that may still be finalized as FAILED or EXPIRED. SUCCEEDED is
 * intentionally absent — a settled swap cannot be degraded.
 */
export const SWAP_IN_FLIGHT_STATUSES = [
  'PENDING',
  'SUBMITTED',
] as const satisfies readonly SwapStatus[];

/**
 * Statuses that may still be promoted to SUCCEEDED. FAILED is included so a
 * Horizon rejection cannot beat on-chain inclusion (observer/submit success
 * heals a false failure).
 */
export const SWAP_CAN_SUCCEED_STATUSES = [
  'PENDING',
  'SUBMITTED',
  'FAILED',
] as const satisfies readonly SwapStatus[];

/** Statuses from which submit may mark the row SUBMITTED. */
export const SWAP_CAN_SUBMIT_STATUSES = [
  'PENDING',
  'FAILED',
] as const satisfies readonly SwapStatus[];
