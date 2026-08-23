import {
  applySlippage,
  computeFee,
  fromStroops,
  toStroops,
} from '../swaps/swap-math';

/**
 * Integer math for AMM liquidity pool operations, in stroops (bigint) like
 * swap-math. Prices are the deposit ratio A/B expressed as a 7-decimal string —
 * the shape `Operation.liquidityPoolDeposit` accepts for minPrice/maxPrice.
 */
const PRICE_SCALE = 10_000_000n; // 7 decimal places, same as stroops

/**
 * The pool price (reserveA / reserveB) bracketed by a slippage tolerance:
 * `[price·(1−bps), price·(1+bps)]`, floor/ceil rounded so the window never
 * shrinks. Used as the deposit's on-chain min/max price bounds.
 */
export function priceBounds(
  reserveAStroops: bigint,
  reserveBStroops: bigint,
  slippageBps: number,
): { minPrice: string; maxPrice: string } {
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > 10_000
  ) {
    throw new RangeError(
      `slippageBps must be an integer in [0, 10000], got ${slippageBps}`,
    );
  }
  if (reserveAStroops <= 0n || reserveBStroops <= 0n) {
    throw new RangeError('Price requires positive amounts on both sides');
  }
  const price = (reserveAStroops * PRICE_SCALE) / reserveBStroops;
  const min = (price * BigInt(10_000 - slippageBps)) / 10_000n;
  const maxNum = price * BigInt(10_000 + slippageBps);
  const max = (maxNum + 9_999n) / 10_000n; // ceil
  if (min <= 0n) {
    throw new RangeError(
      'The price of this pair is too small to express with 7 decimal places',
    );
  }
  return { minPrice: fromStroops(min), maxPrice: fromStroops(max) };
}

/**
 * The pool-ratio-matching counterpart of a deposit: given `amountA`, how much
 * of asset B the pool takes at the current reserves ratio (floor rounded).
 */
export function matchDeposit(
  amountAStroops: bigint,
  reserveAStroops: bigint,
  reserveBStroops: bigint,
): bigint {
  if (reserveAStroops <= 0n) {
    throw new RangeError('reserveA must be positive to derive the B amount');
  }
  return (amountAStroops * reserveBStroops) / reserveAStroops;
}

/**
 * A pool-share holder's proportional claim on one reserve:
 * `shares / totalShares · reserve`, floor rounded.
 */
export function proportionalShare(
  sharesStroops: bigint,
  totalSharesStroops: bigint,
  reserveStroops: bigint,
): bigint {
  if (totalSharesStroops <= 0n) {
    throw new RangeError('totalShares must be positive');
  }
  if (sharesStroops < 0n || sharesStroops > totalSharesStroops) {
    throw new RangeError('shares must be within [0, totalShares]');
  }
  return (sharesStroops * reserveStroops) / totalSharesStroops;
}

/**
 * Average-cost basis of shares still held, derived from our own SUCCEEDED
 * deposits (which recorded `sharesReceived` + settled amounts) and withdrawals.
 * Deposits whose basis was never captured do not count — they are taxed nothing.
 * All values are stroop bigints. Formula is unchanged from the previous inline
 * loop in `LiquidityPoolsService.costBasis`.
 */
export interface CostBasisOp {
  kind: 'DEPOSIT' | 'WITHDRAW';
  shares: string | null;
  sharesReceived: string | null;
  settledAmountA: string | null;
  settledAmountB: string | null;
  amountA: string;
  amountB: string;
}

export function aggregateCostBasis(ops: CostBasisOp[]): {
  depositedShares: bigint;
  remainingShares: bigint;
  costA: bigint;
  costB: bigint;
} {
  let depositedShares = 0n;
  let withdrawnShares = 0n;
  let costA = 0n;
  let costB = 0n;
  for (const o of ops) {
    if (o.kind === 'DEPOSIT') {
      if (!o.sharesReceived) continue; // basis not captured → no known cost
      depositedShares += toStroops(o.sharesReceived);
      costA += toStroops(o.settledAmountA ?? o.amountA);
      costB += toStroops(o.settledAmountB ?? o.amountB);
    } else if (o.shares) {
      withdrawnShares += toStroops(o.shares);
    }
  }
  const remaining = depositedShares - withdrawnShares;
  return {
    depositedShares,
    remainingShares: remaining > 0n ? remaining : 0n,
    costA,
    costB,
  };
}

/**
 * Platform commission on an LP withdraw: charged ONLY on the gain
 * (slippage-protected redemption of covered shares − proportional cost basis),
 * and only for shares whose cost basis we recorded. Shares with no known basis
 * are taxed nothing; a loss is taxed nothing. Formula is unchanged from the
 * previous inline block in `LiquidityPoolsService.withdraw`.
 */
export function computeWithdrawCommission(input: {
  shares: bigint;
  totalShares: bigint;
  remainingShares: bigint;
  depositedShares: bigint;
  costA: bigint;
  costB: bigint;
  reserveA: bigint;
  reserveB: bigint;
  slippageBps: number;
  feeBps: number;
}): { feeA: bigint; feeB: bigint } {
  if (input.feeBps <= 0) return { feeA: 0n, feeB: 0n };
  const covered =
    input.shares < input.remainingShares ? input.shares : input.remainingShares;
  if (covered <= 0n || input.depositedShares <= 0n) {
    return { feeA: 0n, feeB: 0n };
  }
  const redeemedA = applySlippage(
    proportionalShare(covered, input.totalShares, input.reserveA),
    input.slippageBps,
  );
  const redeemedB = applySlippage(
    proportionalShare(covered, input.totalShares, input.reserveB),
    input.slippageBps,
  );
  const basisA = (input.costA * covered) / input.depositedShares;
  const basisB = (input.costB * covered) / input.depositedShares;
  return {
    feeA: computeFee(
      redeemedA > basisA ? redeemedA - basisA : 0n,
      input.feeBps,
    ),
    feeB: computeFee(
      redeemedB > basisB ? redeemedB - basisB : 0n,
      input.feeBps,
    ),
  };
}
