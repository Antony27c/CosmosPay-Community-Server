import type { SwapStatus } from '../../generated/prisma/client';

/**
 * Liquidity pool operation state machine (issue #32).
 *
 * Submit and the settlement observer both write the same row, and that row
 * holds the cost basis used to compute withdraw commission. Once an operation
 * has liquidated on-chain (`SUCCEEDED`) it must never be degraded — a late
 * FAILED/EXPIRED write would drop the deposit from cost-basis aggregation.
 *
 * FAILED is re-submittable (the customer can retry the signed envelope), but
 * on-chain success always wins over a Horizon rejection.
 */
export const LP_OPERATION_STATUSES = [
  'PENDING',
  'SUBMITTED',
  'SUCCEEDED',
  'FAILED',
  'EXPIRED',
] as const satisfies readonly SwapStatus[];

export type LpOperationStatus = (typeof LP_OPERATION_STATUSES)[number];

/**
 * Statuses that may still be finalized as FAILED or EXPIRED. SUCCEEDED is
 * intentionally absent — a liquidated operation cannot be degraded.
 */
export const LP_IN_FLIGHT_STATUSES = [
  'PENDING',
  'SUBMITTED',
] as const satisfies readonly LpOperationStatus[];

/**
 * Statuses that may still be promoted to SUCCEEDED. FAILED is included so a
 * Horizon rejection cannot beat on-chain inclusion (observer/submit success
 * heals a false failure).
 */
export const LP_CAN_SUCCEED_STATUSES = [
  'PENDING',
  'SUBMITTED',
  'FAILED',
] as const satisfies readonly LpOperationStatus[];

/** Statuses from which submit may mark the row SUBMITTED. */
export const LP_CAN_SUBMIT_STATUSES = [
  'PENDING',
  'FAILED',
] as const satisfies readonly LpOperationStatus[];

/** Liquidated on-chain — never overwritten by an error transition. */
export const LP_LIQUIDATED_STATUS =
  'SUCCEEDED' as const satisfies LpOperationStatus;

/**
 * Declared transition graph. Deny-by-default — undeclared edges are invalid.
 * SUCCEEDED and EXPIRED have no outbound edges (true terminals). FAILED may
 * return to SUBMITTED / SUCCEEDED because a retry (or a late on-chain lookup)
 * can still confirm the transaction.
 */
export const LP_OPERATION_TRANSITIONS: Record<
  LpOperationStatus,
  readonly LpOperationStatus[]
> = {
  PENDING: ['SUBMITTED', 'SUCCEEDED', 'FAILED', 'EXPIRED'],
  SUBMITTED: ['SUCCEEDED', 'FAILED', 'EXPIRED'],
  FAILED: ['SUBMITTED', 'SUCCEEDED'],
  SUCCEEDED: [],
  EXPIRED: [],
};

export function canTransitionLp(
  from: LpOperationStatus,
  to: LpOperationStatus,
): boolean {
  return LP_OPERATION_TRANSITIONS[from].includes(to);
}

export function isLpLiquidated(status: LpOperationStatus): boolean {
  return status === LP_LIQUIDATED_STATUS;
}
