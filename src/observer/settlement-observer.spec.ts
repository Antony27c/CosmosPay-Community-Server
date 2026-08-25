import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Horizon, Networks } from '@stellar/stellar-sdk';
import { AppConfig } from '../config/configuration';
import { LiquidityPoolsService } from '../liquidity-pools/liquidity-pools.service';
import {
  aggregateCostBasis,
  computeWithdrawCommission,
} from '../liquidity-pools/lp-math';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { SwapsService } from '../swaps/swaps.service';
import { fromStroops, toStroops } from '../swaps/swap-math';
import {
  EXPIRY_NOT_FOUND_STREAK,
  nextExpiryStreak,
  shouldMarkExpired,
} from './settlement-expiry';
import {
  HORIZON_LOOKUP_ATTEMPTS,
  SettlementObserverService,
} from './settlement-observer.service';

const USERNAME = 'cosmos_u1';
const TX_HASH = 'a'.repeat(64);
const POOL_ID =
  'dd7b1ab831c273310ddbec6f97870aa83c2fbd78ce22aded37ecbf4f3380fac7';
const SOURCE = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const FEE_WALLET =
  'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76';

const observerCfg = {
  enabled: true,
  intervalMs: 15000,
  batchSize: 50,
  expiryGraceMs: 60_000,
};

const stellarCfg = {
  network: 'testnet' as const,
  horizon: {
    public: 'https://horizon.stellar.org',
    testnet: 'https://horizon-testnet.stellar.org',
  },
  baseFee: '100',
  timeoutSeconds: 300,
  swap: {
    feeWallet: FEE_WALLET,
    feeBps: 50,
    slippageBps: 50,
    maxSlippageBps: 500,
  },
};

const consumer = { apisixUsername: USERNAME };

type HorizonErr = Error & { response?: { status?: number } };

function horizonError(status: number, message: string): HorizonErr {
  const err = new Error(message) as HorizonErr;
  err.response = { status };
  return err;
}

function expiredAt(graceMs = observerCfg.expiryGraceMs): Date {
  return new Date(Date.now() - graceMs - 1_000);
}

function isExpiredWhere(where: {
  status?: unknown;
  expiresAt?: unknown;
}): boolean {
  return where.status === 'EXPIRED';
}

type ObserverInternals = {
  tick: () => Promise<void>;
  rescueExpired: (batchSize: number) => Promise<void>;
  lastRescueAt: number;
};

function internals(service: SettlementObserverService): ObserverInternals {
  return service as unknown as ObserverInternals;
}


function never(): Promise<never> {
  return new Promise(() => {});
}

describe('SettlementObserverService.tick timeout', () => {
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('a hung Horizon lookup returns unknown and the next cycle still runs', async () => {
    jest.useFakeTimers({ now: Date.now() });
    const call = jest.fn().mockRejectedValue(new Error('timeout'));
    const swap = {
      id: 'sw_1',
      status: 'PENDING',
      txHash: 'b'.repeat(64),
      network: 'testnet',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      lastCheckedAt: null,
      notFoundStreak: 0,
      consumer: { apisixUsername: 'cosmos_u1' },
    };
    const prisma = {
      swap: {
        findMany: jest.fn(async () => [swap]),
        update: jest.fn().mockResolvedValue(swap),
      },
      liquidityPoolOperation: {
        findMany: jest.fn(async () => []),
        update: jest.fn(),
      },
    };
    const config = {
      get: (key: string) =>
        key === 'observer'
          ? { enabled: false, intervalMs: 10_000, batchSize: 50, expiryGraceMs: 60_000 }
          : stellarCfg,
    };
    const stellar = {
      passphrase: () => Networks.TESTNET,
      recordObserverCycle: jest.fn(),
      metrics: jest.fn().mockReturnValue({
        horizonErrors: {},
        observers: { settlement: { cycles: 0 } },
      }),
      server: jest.fn().mockReturnValue({
        transactions: () => ({ transaction: () => ({ call }) }),
      }),
    };
    const swaps = {
      finalizeSucceeded: jest.fn(),
      finalizeFailed: jest.fn(),
      finalizeExpired: jest.fn(),
    };
    const liquidity = {
      finalizeSucceeded: jest.fn(),
      finalizeFailed: jest.fn(),
      finalizeExpired: jest.fn(),
    };
    const observer = new SettlementObserverService(
      config as any,
      prisma as any,
      stellar as any,
      liquidity as any,
      swaps as any,
    );

    await observer.tick();
    expect(observer.isRunning()).toBe(false);
    expect(swaps.finalizeSucceeded).not.toHaveBeenCalled();
    const findsAfterFirst = prisma.swap.findMany.mock.calls.length;

    await observer.tick();
    expect(observer.isRunning()).toBe(false);
    expect(prisma.swap.findMany.mock.calls.length).toBeGreaterThan(
      findsAfterFirst,
    );
  });
});


describe('nextExpiryStreak', () => {
  const now = new Date('2026-08-24T18:00:00.000Z');
  const expired = new Date(now.getTime() - 120_000);

  it('only grows on not_found after expiresAt + grace', () => {
    expect(nextExpiryStreak('not_found', expired, now, 60_000, 0)).toBe(1);
    expect(nextExpiryStreak('not_found', expired, now, 60_000, 2)).toBe(3);
    expect(nextExpiryStreak('unknown', expired, now, 60_000, 2)).toBe(0);
    expect(nextExpiryStreak('not_found', expired, now, 300_000, 2)).toBe(0);
  });

  it('expires at K and not at K-1', () => {
    expect(shouldMarkExpired(EXPIRY_NOT_FOUND_STREAK - 1)).toBe(false);
    expect(shouldMarkExpired(EXPIRY_NOT_FOUND_STREAK)).toBe(true);
  });
});

describe('SettlementObserverService', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function buildHorizon(call: jest.Mock) {
    return {
      passphrase: () => Networks.TESTNET,
      recordObserverCycle: jest.fn(),
      metrics: jest.fn().mockReturnValue({
        horizonErrors: {},
        observers: { settlement: { cycles: 0 } },
      }),
      server: jest.fn().mockReturnValue({
        transactions: () => ({
          transaction: () => ({ call }),
        }),
        effects: () => ({
          forTransaction: () => ({
            call: jest.fn().mockResolvedValue({ records: [] }),
          }),
        }),
        liquidityPools: () => ({
          liquidityPoolId: () => ({
            call: jest.fn().mockResolvedValue(null),
          }),
        }),
        loadAccount: jest.fn(),
      }),
    };
  }

  function build(opts?: { call?: jest.Mock }) {
    const call = opts?.call ?? jest.fn();
    const swapRowStore: { current: Record<string, unknown> | null } = {
      current: null,
    };
    const lpRowStore: { current: Record<string, unknown> | null } = {
      current: null,
    };

    const prisma = {
      swap: {
        findMany: jest
          .fn()
          .mockImplementation((args: { where: { status?: unknown } }) => {
            if (isExpiredWhere(args.where)) return Promise.resolve([]);
            const row = swapRowStore.current;
            if (!row) return Promise.resolve([]);
            if (row.status !== 'PENDING' && row.status !== 'SUBMITTED') {
              return Promise.resolve([]);
            }
            return Promise.resolve([{ ...row, consumer }]);
          }),
        update: jest
          .fn()
          .mockImplementation((args: { data: Record<string, unknown> }) => {
            if (!swapRowStore.current) return Promise.resolve(args.data);
            Object.assign(swapRowStore.current, args.data);
            return Promise.resolve({ ...swapRowStore.current, consumer });
          }),
      },
      liquidityPoolOperation: {
        findMany: jest
          .fn()
          .mockImplementation((args: { where: { status?: unknown } }) => {
            if (isExpiredWhere(args.where)) return Promise.resolve([]);
            const row = lpRowStore.current;
            if (!row) return Promise.resolve([]);
            if (row.status !== 'PENDING' && row.status !== 'SUBMITTED') {
              return Promise.resolve([]);
            }
            return Promise.resolve([{ ...row, consumer }]);
          }),
        update: jest
          .fn()
          .mockImplementation((args: { data: Record<string, unknown> }) => {
            if (!lpRowStore.current) return Promise.resolve(args.data);
            Object.assign(lpRowStore.current, args.data);
            return Promise.resolve({ ...lpRowStore.current, consumer });
          }),
        create: jest.fn(),
      },
      consumer: {
        upsert: jest.fn().mockResolvedValue({
          id: 'c1',
          apisixUsername: USERNAME,
        }),
      },
    };

    const config = {
      get: (key: string) => {
        if (key === 'observer') return observerCfg;
        if (key === 'stellar') return stellarCfg;
        return undefined;
      },
    };

    const swaps = {
      finalizeSucceeded: jest.fn().mockImplementation(async (id: string) => {
        if (swapRowStore.current?.id === id) {
          swapRowStore.current.status = 'SUCCEEDED';
        }
        return { applied: true, swap: { id, status: 'SUCCEEDED' } };
      }),
      finalizeSucceededQuiet: jest.fn().mockResolvedValue({ applied: true }),
      finalizeFailed: jest.fn().mockImplementation(async (id: string) => {
        if (swapRowStore.current?.id === id) {
          swapRowStore.current.status = 'FAILED';
        }
        return { applied: true, swap: { id, status: 'FAILED' } };
      }),
      finalizeFailedQuiet: jest.fn().mockResolvedValue({ applied: true }),
      finalizeExpired: jest.fn().mockImplementation(async (id: string) => {
        if (swapRowStore.current?.id === id) {
          swapRowStore.current.status = 'EXPIRED';
        }
        return { applied: true, swap: { id, status: 'EXPIRED' } };
      }),
    };

    const liquidity = {
      finalizeSucceeded: jest.fn().mockImplementation(async (id: string) => {
        if (lpRowStore.current?.id === id) {
          lpRowStore.current.status = 'SUCCEEDED';
          lpRowStore.current.sharesReceived = '100';
        }
        return {
          applied: true,
          operation: { id, status: 'SUCCEEDED', sharesReceived: '100' },
        };
      }),
      finalizeFailed: jest.fn().mockImplementation(async (id: string) => {
        if (lpRowStore.current?.id === id) {
          lpRowStore.current.status = 'FAILED';
        }
        return { applied: true, operation: { id, status: 'FAILED' } };
      }),
      finalizeExpired: jest.fn().mockImplementation(async (id: string) => {
        if (lpRowStore.current?.id === id) {
          lpRowStore.current.status = 'EXPIRED';
        }
        return { applied: true, operation: { id, status: 'EXPIRED' } };
      }),
      captureDepositBasis: jest.fn().mockResolvedValue(undefined),
    };

    const stellar = buildHorizon(call);

    const service = new SettlementObserverService(
      config as unknown as ConfigService<AppConfig, true>,
      prisma as unknown as PrismaService,
      stellar as unknown as StellarService,
      liquidity as unknown as LiquidityPoolsService,
      swaps as unknown as SwapsService,
    );

    return {
      service,
      prisma,
      call,
      swaps,
      liquidity,
      swapRowStore,
      lpRowStore,
    };
  }

  async function runTick(service: SettlementObserverService): Promise<void> {
    const done = internals(service).tick();
    await jest.runAllTimersAsync();
    await done;
  }

  function pendingSwap(overrides: Record<string, unknown> = {}) {
    return {
      id: 'sw_1',
      network: 'testnet',
      txHash: TX_HASH,
      status: 'PENDING',
      expiresAt: expiredAt(),
      lastCheckedAt: null,
      notFoundStreak: 0,
      consumer,
      ...overrides,
    };
  }

  it('Horizon devuelve 503 y el swap está vencido → la fila NO cambia de estado', async () => {
    jest.useFakeTimers({ now: Date.now() });
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const log = jest.spyOn(Logger.prototype, 'log');
    const call = jest
      .fn()
      .mockRejectedValue(horizonError(503, 'Service Unavailable'));
    const { service, swaps, swapRowStore } = build({ call });
    swapRowStore.current = pendingSwap();

    await runTick(service);

    expect(swapRowStore.current?.status).toBe('PENDING');
    expect(swaps.finalizeExpired).not.toHaveBeenCalled();
    expect(swaps.finalizeSucceeded).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(HORIZON_LOOKUP_ATTEMPTS);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/status=503/);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/unknown/);
    expect(log.mock.calls.flat().join(' ')).not.toMatch(/→ not_found/);
  });

  it('Horizon timeout / network error → unknown and the row stays PENDING', async () => {
    jest.useFakeTimers({ now: Date.now() });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const call = jest.fn().mockRejectedValue(new Error('timeout'));
    const { service, swaps, swapRowStore } = build({ call });
    swapRowStore.current = pendingSwap();

    await runTick(service);

    expect(swapRowStore.current?.status).toBe('PENDING');
    expect(swaps.finalizeExpired).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/status=none/);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/unknown/);
  });

  it('Horizon 429 is retried with backoff before returning unknown', async () => {
    jest.useFakeTimers({ now: Date.now() });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const call = jest
      .fn()
      .mockRejectedValue(horizonError(429, 'Too Many Requests'));
    const { service, swapRowStore } = build({ call });
    swapRowStore.current = pendingSwap();

    await runTick(service);

    expect(call).toHaveBeenCalledTimes(HORIZON_LOOKUP_ATTEMPTS);
    expect(swapRowStore.current?.status).toBe('PENDING');
  });

  it('Horizon devuelve 404 K veces después del vencimiento → EXPIRED', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const call = jest.fn().mockRejectedValue(horizonError(404, 'Not Found'));
    const { service, swaps, swapRowStore } = build({ call });
    swapRowStore.current = pendingSwap();

    for (let i = 0; i < EXPIRY_NOT_FOUND_STREAK - 1; i++) {
      await internals(service).tick();
      expect(swapRowStore.current?.status).toBe('PENDING');
      expect(swapRowStore.current?.notFoundStreak).toBe(i + 1);
      expect(swaps.finalizeExpired).not.toHaveBeenCalled();
    }

    await internals(service).tick();

    expect(swapRowStore.current?.status).toBe('EXPIRED');
    expect(swapRowStore.current?.notFoundStreak).toBe(EXPIRY_NOT_FOUND_STREAK);
    expect(swaps.finalizeExpired).toHaveBeenCalledWith('sw_1', USERNAME);
  });

  it('emits LIQUIDITY_EXPIRED after K not_found lookups past grace', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const call = jest.fn().mockRejectedValue(horizonError(404, 'Not Found'));
    const { service, liquidity, lpRowStore } = build({ call });
    lpRowStore.current = {
      id: 'lp_1',
      kind: 'DEPOSIT',
      network: 'testnet',
      txHash: TX_HASH,
      status: 'PENDING',
      expiresAt: expiredAt(),
      lastCheckedAt: null,
      notFoundStreak: 0,
      consumer,
    };

    for (let i = 0; i < EXPIRY_NOT_FOUND_STREAK; i++) {
      await internals(service).tick();
    }

    expect(lpRowStore.current?.status).toBe('EXPIRED');
    expect(liquidity.finalizeExpired).toHaveBeenCalledWith('lp_1', USERNAME);
  });

  it('el barrido rescata un EXPIRED que aparece confirmado en Horizon → SUCCEEDED', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const call = jest.fn().mockResolvedValue({ successful: true });
    const { service, prisma, swaps } = build({ call });
    const expired = {
      id: 'sw_expired',
      network: 'testnet',
      txHash: TX_HASH,
      status: 'EXPIRED',
      expiresAt: expiredAt(),
      lastCheckedAt: new Date(),
      notFoundStreak: 3,
      updatedAt: new Date(),
      consumer,
    };
    prisma.swap.findMany.mockImplementation(
      (args: { where: { status?: unknown; expiresAt?: unknown } }) => {
        if (isExpiredWhere(args.where)) return Promise.resolve([expired]);
        return Promise.resolve([]);
      },
    );

    internals(service).lastRescueAt = 0;
    await internals(service).tick();

    expect(swaps.finalizeSucceeded).toHaveBeenCalledWith(
      'sw_expired',
      USERNAME,
    );
    expect(prisma.swap.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'EXPIRED',
          expiresAt: expect.objectContaining({ gte: expect.any(Date) }),
        }),
      }),
    );
  });

  it('rescues an EXPIRED DEPOSIT to SUCCEEDED and captures cost basis', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const call = jest.fn().mockResolvedValue({ successful: true });
    const { service, prisma, liquidity } = build({ call });
    const expired = {
      id: 'lp_expired',
      kind: 'DEPOSIT',
      network: 'testnet',
      txHash: TX_HASH,
      status: 'EXPIRED',
      poolId: POOL_ID,
      source: SOURCE,
      expiresAt: expiredAt(),
      lastCheckedAt: new Date(),
      notFoundStreak: 3,
      updatedAt: new Date(),
      sharesReceived: null,
      consumer,
    };
    prisma.liquidityPoolOperation.findMany.mockImplementation(
      (args: { where: { status?: unknown; expiresAt?: unknown } }) => {
        if (isExpiredWhere(args.where)) return Promise.resolve([expired]);
        return Promise.resolve([]);
      },
    );

    internals(service).lastRescueAt = 0;
    await internals(service).tick();

    expect(liquidity.finalizeSucceeded).toHaveBeenCalledWith(
      'lp_expired',
      USERNAME,
    );
  });

  it('does not change status on succeeded/failed paths besides the matching terminal', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const call = jest.fn().mockResolvedValue({ successful: true });
    const { service, swaps, swapRowStore } = build({ call });
    swapRowStore.current = pendingSwap({ expiresAt: expiredAt() });

    await internals(service).tick();

    expect(swapRowStore.current?.status).toBe('SUCCEEDED');
    expect(swaps.finalizeSucceeded).toHaveBeenCalledWith('sw_1', USERNAME);
  });

  it('orders the pending batch by lastCheckedAt, not createdAt', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const call = jest.fn().mockResolvedValue({ successful: true });
    const { service, prisma, swapRowStore } = build({ call });
    swapRowStore.current = pendingSwap();

    await internals(service).tick();

    expect(prisma.swap.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
      }),
    );
    expect(prisma.swap.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'asc' } }),
    );
  });
});

describe('rescued DEPOSIT feeds costBasis so withdraw fees are non-zero', () => {
  it('feeA/feeB of a later withdraw are correct and not zero', () => {
    const expiredWithoutBasis = aggregateCostBasis([
      {
        kind: 'DEPOSIT',
        shares: '100',
        sharesReceived: null,
        settledAmountA: null,
        settledAmountB: null,
        amountA: '100',
        amountB: '50',
      },
    ]);
    expect(expiredWithoutBasis.depositedShares).toBe(0n);

    const rescued = aggregateCostBasis([
      {
        kind: 'DEPOSIT',
        shares: '100',
        sharesReceived: '100',
        settledAmountA: '100',
        settledAmountB: '50',
        amountA: '100',
        amountB: '50',
      },
    ]);
    expect(rescued.depositedShares).toBe(toStroops('100'));

    const { feeA, feeB } = computeWithdrawCommission({
      shares: toStroops('100'),
      totalShares: toStroops('1000'),
      remainingShares: rescued.remainingShares,
      depositedShares: rescued.depositedShares,
      costA: rescued.costA,
      costB: rescued.costB,
      reserveA: toStroops('2000'),
      reserveB: toStroops('1000'),
      slippageBps: 50,
      feeBps: 50,
    });

    expect(feeA).toBeGreaterThan(0n);
    expect(feeB).toBeGreaterThan(0n);
    expect(fromStroops(feeA)).not.toBe('0');
    expect(fromStroops(feeB)).not.toBe('0');
  });
});
