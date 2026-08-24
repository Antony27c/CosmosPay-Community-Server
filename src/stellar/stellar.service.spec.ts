import { ServiceUnavailableException } from '@nestjs/common';
import { Horizon } from '@stellar/stellar-sdk';
import {
  HorizonTimeoutError,
  StellarService,
  horizonHttpStatus,
  isRetryableHorizonError,
} from './stellar.service';

function horizonError(status: number): Error {
  const err = new Error(`Horizon ${status}`) as Error & {
    response: { status: number };
  };
  err.response = { status };
  return err;
}

function networkError(code: string): Error {
  const err = new Error('connect failed') as Error & { code: string };
  err.code = code;
  return err;
}

function makeService(
  overrides: {
    httpTimeoutMs?: number;
    maxAttempts?: number;
    retryBaseMs?: number;
  } = {},
) {
  const stellar = {
    horizon: {
      public: 'https://horizon.test',
      testnet: 'https://horizon.test',
    },
    httpTimeoutMs: overrides.httpTimeoutMs ?? 10_000,
    maxAttempts: overrides.maxAttempts ?? 3,
    retryBaseMs: overrides.retryBaseMs ?? 100,
  };
  const config = {
    get: () => stellar,
  } as any;
  return new StellarService(config);
}

describe('horizon error helpers', () => {
  it('reads status from response.status', () => {
    expect(horizonHttpStatus(horizonError(404))).toBe(404);
  });

  it('treats 429, 5xx, timeouts and network codes as retryable', () => {
    expect(isRetryableHorizonError(horizonError(429))).toBe(true);
    expect(isRetryableHorizonError(horizonError(502))).toBe(true);
    expect(isRetryableHorizonError(new HorizonTimeoutError(10))).toBe(true);
    expect(isRetryableHorizonError(networkError('ECONNRESET'))).toBe(true);
    expect(isRetryableHorizonError(horizonError(404))).toBe(false);
    expect(isRetryableHorizonError(horizonError(400))).toBe(false);
  });
});

describe('StellarService.call', () => {
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('returns the fn result on the first success', async () => {
    const service = makeService();
    const out = await service.call('testnet', async () => ({ ok: true }));
    expect(out).toEqual({ ok: true });
  });

  it('retries two 429s then succeeds, with growing backoff delays', async () => {
    const service = makeService({ maxAttempts: 3, retryBaseMs: 100 });
    jest.spyOn(service, 'jitter').mockReturnValue(0);
    const delays: number[] = [];
    jest.spyOn(service, 'sleep').mockImplementation(async (ms: number) => {
      delays.push(ms);
    });

    let attempts = 0;
    const result = await service.call('testnet', async () => {
      attempts += 1;
      if (attempts <= 2) {
        throw horizonError(429);
      }
      return { hash: 'ok' };
    });

    expect(result).toEqual({ hash: 'ok' });
    expect(attempts).toBe(3);
    expect(delays).toEqual([100, 200]);
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(service.metrics().horizonErrors['429']).toBe(2);
  });

  it('maps exhausted 5xx retries to ServiceUnavailableException, not the raw Horizon error', async () => {
    const service = makeService({ maxAttempts: 3, retryBaseMs: 10 });
    jest.spyOn(service, 'sleep').mockResolvedValue(undefined);

    const raw = horizonError(502);
    let thrown: unknown;
    try {
      await service.call('testnet', async () => {
        throw raw;
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    expect(thrown).not.toBe(raw);
    expect((thrown as ServiceUnavailableException).message).toBe(
      'Could not reach the Stellar network',
    );
    expect(service.metrics().horizonErrors['502']).toBe(3);
  });

  it('propagates 404 as the original Horizon error (not 503)', async () => {
    const service = makeService({ maxAttempts: 3 });
    const sleep = jest.spyOn(service, 'sleep');
    const raw = horizonError(404);

    await expect(
      service.call('testnet', async () => {
        throw raw;
      }),
    ).rejects.toBe(raw);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('times out a Horizon that never responds (fake timers)', async () => {
    const service = makeService({ httpTimeoutMs: 50, maxAttempts: 1 });
    jest.useFakeTimers();

    const pending = service.call('testnet', () => new Promise(() => {}));
    const assertion = expect(pending).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await jest.advanceTimersByTimeAsync(50);
    await assertion;
    await expect(pending).rejects.toThrow('Stellar Horizon request timed out');
  });

  it('maps ECONNRESET after retries to ServiceUnavailableException', async () => {
    const service = makeService({ maxAttempts: 2, retryBaseMs: 1 });
    jest.spyOn(service, 'sleep').mockResolvedValue(undefined);

    await expect(
      service.call('public', async () => {
        throw networkError('ECONNRESET');
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('passes a cached Horizon.Server into fn', async () => {
    const service = makeService();
    const seen: Horizon.Server[] = [];
    await service.call('testnet', async (server) => {
      seen.push(server);
      return 1;
    });
    await service.call('testnet', async (server) => {
      seen.push(server);
      return 2;
    });
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toBeInstanceOf(Horizon.Server);
  });
});
