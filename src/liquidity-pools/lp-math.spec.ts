import { toStroops } from '../swaps/swap-math';
import {
  aggregateCostBasis,
  computeWithdrawCommission,
  matchDeposit,
  priceBounds,
  proportionalShare,
} from './lp-math';

describe('priceBounds', () => {
  it('brackets the reserves ratio by the slippage tolerance', () => {
    // 1000 XLM / 100 USDC → price 10, ±1% → [9.9, 10.1]
    const { minPrice, maxPrice } = priceBounds(
      toStroops('1000'),
      toStroops('100'),
      100,
    );
    expect(minPrice).toBe('9.9');
    expect(maxPrice).toBe('10.1');
  });

  it('never narrows the window on rounding', () => {
    const { minPrice, maxPrice } = priceBounds(
      toStroops('1'),
      toStroops('3'),
      1,
    );
    // price ≈ 0.3333333; min floors, max ceils
    expect(parseFloat(minPrice)).toBeLessThan(1 / 3);
    expect(parseFloat(maxPrice)).toBeGreaterThan(1 / 3);
  });

  it('rejects a price too small for 7 decimals', () => {
    expect(() => priceBounds(1n, toStroops('10000000000'), 0)).toThrow(
      RangeError,
    );
  });

  it('rejects empty reserves and bad slippage', () => {
    expect(() => priceBounds(0n, 1n, 0)).toThrow(RangeError);
    expect(() => priceBounds(1n, 1n, 10_001)).toThrow(RangeError);
  });
});

describe('matchDeposit', () => {
  it('derives the B amount from the reserves ratio', () => {
    // reserves 1000:100 → depositing 50 A takes 5 B
    expect(
      matchDeposit(toStroops('50'), toStroops('1000'), toStroops('100')),
    ).toBe(toStroops('5'));
  });

  it('floors the result', () => {
    expect(matchDeposit(1n, 3n, 1n)).toBe(0n);
  });
});

describe('proportionalShare', () => {
  it('computes the proportional claim on a reserve', () => {
    // 10% of the shares → 10% of the reserve
    expect(
      proportionalShare(toStroops('10'), toStroops('100'), toStroops('5000')),
    ).toBe(toStroops('500'));
  });

  it('rejects shares above total and an empty pool', () => {
    expect(() => proportionalShare(2n, 1n, 1n)).toThrow(RangeError);
    expect(() => proportionalShare(1n, 0n, 1n)).toThrow(RangeError);
  });
});

describe('aggregateCostBasis (deposit)', () => {
  it('records a settled deposit as the cost basis for later withdraws', () => {
    const basis = aggregateCostBasis([
      {
        kind: 'DEPOSIT',
        shares: null,
        sharesReceived: '100',
        settledAmountA: '1000',
        settledAmountB: '100',
        amountA: '1000',
        amountB: '100',
      },
    ]);
    expect(basis.depositedShares).toBe(toStroops('100'));
    expect(basis.remainingShares).toBe(toStroops('100'));
    expect(basis.costA).toBe(toStroops('1000'));
    expect(basis.costB).toBe(toStroops('100'));
  });

  it('ignores deposits whose basis was never captured', () => {
    const basis = aggregateCostBasis([
      {
        kind: 'DEPOSIT',
        shares: null,
        sharesReceived: null,
        settledAmountA: null,
        settledAmountB: null,
        amountA: '1000',
        amountB: '100',
      },
    ]);
    expect(basis.depositedShares).toBe(0n);
    expect(basis.remainingShares).toBe(0n);
    expect(basis.costA).toBe(0n);
    expect(basis.costB).toBe(0n);
  });
});

describe('computeWithdrawCommission', () => {
  const pool = {
    totalShares: toStroops('100'),
    remainingShares: toStroops('100'),
    depositedShares: toStroops('100'),
    costA: toStroops('1000'),
    costB: toStroops('100'),
    slippageBps: 0,
    feeBps: 50, // 0.5%
  };

  it('charges the plan fee on a withdraw with a gain', () => {
    // Reserves doubled since deposit → redeeming 100 shares returns 2000/200.
    // Gain = 1000 A + 100 B; 50 bps → 5 A + 0.5 B.
    const { feeA, feeB } = computeWithdrawCommission({
      ...pool,
      shares: toStroops('100'),
      reserveA: toStroops('2000'),
      reserveB: toStroops('200'),
    });
    expect(feeA).toBe(toStroops('5'));
    expect(feeB).toBe(toStroops('0.5'));
  });

  it('charges nothing on a withdraw with a loss', () => {
    // Reserves halved → redeemed 500/50 is below cost 1000/100.
    const { feeA, feeB } = computeWithdrawCommission({
      ...pool,
      shares: toStroops('100'),
      reserveA: toStroops('500'),
      reserveB: toStroops('50'),
    });
    expect(feeA).toBe(0n);
    expect(feeB).toBe(0n);
  });

  it('charges only the covered shares on a partial withdraw', () => {
    // Withdraw 40 of 100 shares against doubled reserves.
    // Covered basis = 400 A + 40 B; redeemed = 800 A + 80 B;
    // gain = 400 A + 40 B; 50 bps → 2 A + 0.2 B.
    const { feeA, feeB } = computeWithdrawCommission({
      ...pool,
      shares: toStroops('40'),
      reserveA: toStroops('2000'),
      reserveB: toStroops('200'),
    });
    expect(feeA).toBe(toStroops('2'));
    expect(feeB).toBe(toStroops('0.2'));
  });

  it('charges nothing when no cost basis is known', () => {
    const { feeA, feeB } = computeWithdrawCommission({
      ...pool,
      remainingShares: 0n,
      depositedShares: 0n,
      costA: 0n,
      costB: 0n,
      shares: toStroops('100'),
      reserveA: toStroops('2000'),
      reserveB: toStroops('200'),
    });
    expect(feeA).toBe(0n);
    expect(feeB).toBe(0n);
  });
});
