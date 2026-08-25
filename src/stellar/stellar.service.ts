import {
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Horizon, Networks } from '@stellar/stellar-sdk';
import { AppConfig, StellarNetwork } from '../config/configuration';

/**
 * Horizon hung past the per-request budget. Distinct from a 5xx so callers
 * and metrics can tell a dead socket from an explicit upstream error.
 */
export class HorizonTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Horizon request timed out after ${timeoutMs}ms`);
    this.name = 'HorizonTimeoutError';
  }
}

export interface StellarCallOptions {
  /** Override STELLAR_HTTP_TIMEOUT_MS for this call. */
  timeoutMs?: number;
  /** Override STELLAR_MAX_ATTEMPTS for this call (e.g. 1 on health probes). */
  maxAttempts?: number;
}

export interface ObserverCycleStats {
  cycles: number;
  reconciled: number;
  lastDurationMs: number;
  watchdogTrips: number;
}

export interface StellarMetrics {
  horizonErrors: Record<string, number>;
  observers: {
    'payment-intents': ObserverCycleStats;
    settlement: ObserverCycleStats;
  };
}

export type ObserverName = keyof StellarMetrics['observers'];

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ECONNABORTED',
]);

const emptyObserverStats = (): ObserverCycleStats => ({
  cycles: 0,
  reconciled: 0,
  lastDurationMs: 0,
  watchdogTrips: 0,
});

/** HTTP status attached by the Horizon SDK (axios/feaxios-shaped errors). */
export function horizonHttpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') {
    return undefined;
  }
  const e = err as { status?: number; response?: { status?: number } };
  if (typeof e.response?.status === 'number') {
    return e.response.status;
  }
  if (typeof e.status === 'number') {
    return e.status;
  }
  return undefined;
}

function errnoCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') {
    return undefined;
  }
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  if (typeof e.code === 'string') {
    return e.code;
  }
  if (typeof e.cause?.code === 'string') {
    return e.cause.code;
  }
  return undefined;
}

export function isRetryableHorizonError(err: unknown): boolean {
  if (err instanceof HorizonTimeoutError) {
    return true;
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return true;
  }
  const status = horizonHttpStatus(err);
  if (status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }
  const code = errnoCode(err);
  if (code && NETWORK_CODES.has(code)) {
    return true;
  }
  return false;
}

/**
 * Resolves Stellar primitives per network. Because a payment intent's network is
 * derived from the caller's API key type (dev → testnet, prod → public), every
 * Horizon interaction must target the right network — this service hands out the
 * correct (cached) Horizon server and network passphrase for a given network.
 *
 * All new Horizon traffic should go through {@link StellarService.call} so every
 * request gets a timeout, exponential retry, and Nest exception mapping. `server()`
 * remains for the swap / liquidity-pool follow-up that still maps errors locally.
 */
@Injectable()
export class StellarService {
  private readonly logger = new Logger(StellarService.name);
  private readonly servers = new Map<StellarNetwork, Horizon.Server>();
  private readonly horizonErrors: Record<string, number> = {};
  private readonly observerStats: StellarMetrics['observers'] = {
    'payment-intents': emptyObserverStats(),
    settlement: emptyObserverStats(),
  };

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  passphrase(network: StellarNetwork): string {
    return network === 'public' ? Networks.PUBLIC : Networks.TESTNET;
  }

  server(network: StellarNetwork): Horizon.Server {
    let server = this.servers.get(network);
    if (!server) {
      const url = this.config.get('stellar', { infer: true }).horizon[network];
      server = new Horizon.Server(url);
      this.servers.set(network, server);
    }
    return server;
  }

  /**
   * Single outbound path to Horizon: timeout + exponential retry + Nest mapping.
   *
   * stellar-sdk v16 `CallBuilder.call()` does not accept an AbortSignal, and the
   * bundled fetch HTTP client does not honor `timeout` on request config. We
   * therefore race the Horizon promise against a timer ({@link withTimeout}).
   * A hung TCP socket may outlive the race; observer watchdogs are the second
   * line of defense.
   */
  async call<T>(
    network: StellarNetwork,
    fn: (server: Horizon.Server) => Promise<T>,
    options: StellarCallOptions = {},
  ): Promise<T> {
    const cfg = this.config.get('stellar', { infer: true });
    const timeoutMs = options.timeoutMs ?? cfg.httpTimeoutMs ?? 10_000;
    const maxAttempts = options.maxAttempts ?? cfg.maxAttempts ?? 3;
    const retryBaseMs = cfg.retryBaseMs ?? 250;
    const server = this.server(network);

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.withTimeout(
          Promise.resolve().then(() => fn(server)),
          timeoutMs,
        );
      } catch (err) {
        lastError = err;
        // 404 is a business miss (tx/account not on-chain yet), not infra.
        if (horizonHttpStatus(err) === 404) {
          throw err;
        }
        this.recordHorizonError(err);

        if (isRetryableHorizonError(err) && attempt < maxAttempts) {
          const delay = this.backoffMs(attempt - 1, retryBaseMs);
          this.logger.warn(
            `Horizon ${network} attempt ${attempt}/${maxAttempts} failed; retrying in ${delay}ms`,
          );
          await this.sleep(delay);
          continue;
        }

        throw this.toException(err);
      }
    }

    throw this.toException(lastError);
  }

  metrics(): StellarMetrics {
    return {
      horizonErrors: { ...this.horizonErrors },
      observers: {
        'payment-intents': { ...this.observerStats['payment-intents'] },
        settlement: { ...this.observerStats.settlement },
      },
    };
  }

  recordObserverCycle(
    name: ObserverName,
    stats: { durationMs: number; reconciled: number },
  ): void {
    const cur = this.observerStats[name];
    cur.cycles += 1;
    cur.reconciled += stats.reconciled;
    cur.lastDurationMs = stats.durationMs;
  }

  recordWatchdogTrip(name: ObserverName): void {
    this.observerStats[name].watchdogTrips += 1;
  }

  /**
   * Exponential backoff with equal jitter: `base * 2^attempt + random(0, base)`.
   * Public so tests can assert the *observed* delays, not only the final result.
   */
  backoffMs(attemptIndex: number, baseMs: number): number {
    return baseMs * 2 ** attemptIndex + this.jitter(baseMs);
  }

  /** Test seam: delay between Horizon retries. */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /** Test seam: extra ms added on top of the exponential term. */
  jitter(maxExclusive: number): number {
    if (maxExclusive <= 0) {
      return 0;
    }
    return Math.floor(Math.random() * maxExclusive);
  }

  /**
   * Race `work` against a timer. The losing branch is ignored; we cannot cancel
   * the underlying HTTP request (no AbortSignal on CallBuilder.call in v16).
   */
  private withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new HorizonTimeoutError(timeoutMs));
      }, timeoutMs);
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  private recordHorizonError(err: unknown): void {
    const key = this.errorKey(err);
    this.horizonErrors[key] = (this.horizonErrors[key] ?? 0) + 1;
  }

  private errorKey(err: unknown): string {
    if (err instanceof HorizonTimeoutError) {
      return 'timeout';
    }
    const status = horizonHttpStatus(err);
    if (status !== undefined) {
      return String(status);
    }
    const code = errnoCode(err);
    if (code) {
      return code;
    }
    return 'unknown';
  }

  private toException(err: unknown): unknown {
    if (err instanceof HttpException) {
      return err;
    }
    const status = horizonHttpStatus(err);
    if (status === 429) {
      return new ServiceUnavailableException(
        'Stellar Horizon is rate-limiting requests',
      );
    }
    if (err instanceof HorizonTimeoutError) {
      return new ServiceUnavailableException(
        'Stellar Horizon request timed out',
      );
    }
    return new ServiceUnavailableException(
      'Could not reach the Stellar network',
    );
  }
}
