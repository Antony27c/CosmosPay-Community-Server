import { Horizon } from '@stellar/stellar-sdk';
import { SettlementObserverService } from './settlement-observer.service';
import { StellarService } from '../stellar/stellar.service';

function never(): Promise<never> {
  return new Promise(() => {});
}

describe('SettlementObserverService.tick timeout', () => {
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('a Horizon that never responds finishes within the timeout and the next cycle runs', async () => {
    const httpTimeoutMs = 50;
    const stellarCfg = {
      horizon: {
        public: 'https://horizon.test',
        testnet: 'https://horizon.test',
      },
      httpTimeoutMs,
      maxAttempts: 1,
      retryBaseMs: 1,
    };
    const observerCfg = {
      enabled: false,
      intervalMs: 10_000,
      batchSize: 50,
    };
    const config = {
      get: (key: string) => (key === 'observer' ? observerCfg : stellarCfg),
    } as any;

    const swap = {
      id: 'sw_1',
      status: 'PENDING',
      txHash: 'b'.repeat(64),
      network: 'testnet',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      consumer: { apisixUsername: 'cosmos_u1' },
    };
    const prisma = {
      swap: {
        findMany: jest.fn(async () => [swap]),
      },
      liquidityPoolOperation: {
        findMany: jest.fn(async () => []),
      },
    };
    const stellar = new StellarService(config);
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
      config,
      prisma as any,
      stellar,
      liquidity as any,
      swaps as any,
    );

    jest.spyOn(Horizon.Server.prototype, 'transactions').mockReturnValue({
      transaction: () => ({ call: () => never() }),
    } as any);
    jest.useFakeTimers();

    const first = observer.tick();
    await jest.advanceTimersByTimeAsync(httpTimeoutMs);
    await first;

    expect(observer.isRunning()).toBe(false);
    expect(swaps.finalizeSucceeded).not.toHaveBeenCalled();
    const findsAfterFirst = prisma.swap.findMany.mock.calls.length;
    expect(findsAfterFirst).toBe(1);

    const second = observer.tick();
    await jest.advanceTimersByTimeAsync(httpTimeoutMs);
    await second;

    expect(observer.isRunning()).toBe(false);
    expect(prisma.swap.findMany.mock.calls.length).toBeGreaterThan(
      findsAfterFirst,
    );
  });
});
