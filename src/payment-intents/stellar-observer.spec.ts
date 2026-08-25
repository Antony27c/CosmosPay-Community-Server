import { Horizon } from '@stellar/stellar-sdk';
import { StellarObserverService } from './stellar-observer.service';
import { StellarService } from '../stellar/stellar.service';
import { StellarVerifierService } from './stellar-verifier.service';

function never(): Promise<never> {
  return new Promise(() => {});
}

function mockHorizonNever() {
  jest.spyOn(Horizon.Server.prototype, 'transactions').mockReturnValue({
    transaction: () => ({ call: () => never() }),
  } as any);
  jest.spyOn(Horizon.Server.prototype, 'payments').mockReturnValue({
    forTransaction: () => ({ call: () => never() }),
    forAccount: () => ({
      order: () => ({
        limit: () => ({ call: () => never() }),
      }),
    }),
  } as any);
}

describe('StellarObserverService.tick timeout', () => {
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

    const intent = {
      id: 'pi_1',
      status: 'PENDING',
      txHash: 'a'.repeat(64),
      network: 'testnet',
      destination: 'GDEST',
      amount: '1',
      asset: 'native',
      assetIssuer: null,
      memo: '1',
      consumer: { apisixUsername: 'cosmos_u1' },
    };
    const prisma = {
      paymentIntent: {
        findMany: jest.fn(async ({ where }: any) => {
          if (where.status === 'PENDING') return [intent];
          return [];
        }),
      },
    };
    const stellar = new StellarService(config);
    const verifier = new StellarVerifierService(stellar);
    const paymentIntents = {
      markExpired: jest.fn(),
      markSucceeded: jest.fn(),
    };
    const observer = new StellarObserverService(
      config,
      prisma as any,
      verifier,
      paymentIntents as any,
      stellar,
    );

    mockHorizonNever();
    jest.useFakeTimers();

    const first = observer.tick();
    await jest.advanceTimersByTimeAsync(httpTimeoutMs);
    await first;

    expect(observer.isRunning()).toBe(false);
    expect(paymentIntents.markSucceeded).not.toHaveBeenCalled();
    const findsAfterFirst = prisma.paymentIntent.findMany.mock.calls.length;
    expect(findsAfterFirst).toBeGreaterThanOrEqual(2);

    const second = observer.tick();
    await jest.advanceTimersByTimeAsync(httpTimeoutMs);
    await second;

    expect(observer.isRunning()).toBe(false);
    expect(prisma.paymentIntent.findMany.mock.calls.length).toBeGreaterThan(
      findsAfterFirst,
    );
  });
});
