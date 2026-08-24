import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig, StellarNetwork } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { LiquidityPoolsService } from '../liquidity-pools/liquidity-pools.service';
import { SwapsService } from '../swaps/swaps.service';
import { nextExpiryStreak, shouldMarkExpired } from './settlement-expiry';

/** On-chain settlement of a stored transaction, keyed by its hash. */
type Settlement = 'succeeded' | 'failed' | 'not_found' | 'unknown';

/** Horizon lookups per `settlementOf` call (initial + retries on 429/5xx). */
export const HORIZON_LOOKUP_ATTEMPTS = 3;
const HORIZON_RETRY_BACKOFF_MS = 200;
const RESCUE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const RESCUE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Permanent settlement observer for swaps and liquidity pool operations. Both
 * are non-custodial: the customer signs and broadcasts the transaction we built,
 * and may do so **without** calling our submit endpoint (e.g. straight from their
 * wallet via the SEP-7 link). Signing does not change the transaction hash, so on
 * a fixed interval we look each PENDING/SUBMITTED row up on Horizon **by its
 * stored txHash** and finalize it — SUCCEEDED / FAILED (with the matching webhook
 * event) or EXPIRED once its timebounds lapse *and* Horizon has confirmed the
 * hash is absent. Mirrors the payment-intent observer; polling survives restarts
 * with no cursor bookkeeping.
 *
 * Observer never emits webhooks itself. Terminal events are a consequence of
 * winning `finalizeSucceeded` / `finalizeFailed` / `finalizeExpired` on the
 * domain service — the same functions submit uses — so a parallel
 * observer+submit race produces one event, not two.
 */
@Injectable()
export class SettlementObserverService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SettlementObserverService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastRescueAt = 0;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly liquidity: LiquidityPoolsService,
    private readonly swaps: SwapsService,
  ) {}

  onModuleInit(): void {
    const { enabled, intervalMs } = this.config.get('observer', {
      infer: true,
    });
    if (!enabled) {
      this.logger.log('Settlement observer disabled (OBSERVER_ENABLED=false)');
      return;
    }
    this.logger.log(`Settlement observer started (every ${intervalMs}ms)`);
    // `unref` so the interval never keeps the process alive on its own.
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // never overlap cycles
    this.running = true;
    try {
      const { batchSize } = this.config.get('observer', { infer: true });
      await this.reconcileSwaps(batchSize);
      await this.reconcileLiquidity(batchSize);
      await this.maybeRescueExpired(batchSize);
    } catch (err) {
      this.logger.error('Settlement observer cycle failed', err as Error);
    } finally {
      this.running = false;
    }
  }

  // ── Swaps ────────────────────────────────────────────────────────────────
  private async reconcileSwaps(batchSize: number): Promise<void> {
    const rows = await this.prisma.swap.findMany({
      where: { status: { in: ['PENDING', 'SUBMITTED'] } },
      include: { consumer: true },
      orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: batchSize,
    });
    const now = new Date();
    const { expiryGraceMs } = this.config.get('observer', { infer: true });

    // One Horizon lookup per txHash. Historical duplicate hashes (pre-migration)
    // must not mint multiple SWAP_SUCCEEDED / SWAP_FAILED for one on-chain tx.
    const byHash = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = byHash.get(row.txHash) ?? [];
      group.push(row);
      byHash.set(row.txHash, group);
    }

    for (const [, group] of byHash) {
      const primary = group[0];
      const settlement = await this.settlementOf(
        primary.network,
        primary.txHash,
      );

      if (settlement === 'succeeded') {
        for (let i = 0; i < group.length; i++) {
          const row = group[i];
          const username = row.consumer.apisixUsername;
          if (i === 0) {
            const { applied } = await this.swaps.finalizeSucceeded(
              row.id,
              username,
            );
            if (applied) {
              this.logger.log(`Reconciled swap ${row.id} → SUCCEEDED`);
            }
          } else {
            // Duplicate hash: settle the phantom row without a second webhook.
            const { applied } = await this.swaps.finalizeSucceededQuiet(row.id);
            if (applied) {
              this.logger.log(
                `Reconciled duplicate-hash swap ${row.id} → SUCCEEDED (no webhook)`,
              );
            }
          }
          await this.touchSwapCheck(row.id, now, 0);
        }
      } else if (settlement === 'failed') {
        for (let i = 0; i < group.length; i++) {
          const row = group[i];
          const username = row.consumer.apisixUsername;
          if (i === 0) {
            const { applied } = await this.swaps.finalizeFailed(
              row.id,
              username,
            );
            if (applied) {
              this.logger.warn(`Reconciled swap ${row.id} → FAILED`);
            }
          } else {
            const { applied } = await this.swaps.finalizeFailedQuiet(row.id);
            if (applied) {
              this.logger.warn(
                `Reconciled duplicate-hash swap ${row.id} → FAILED (no webhook)`,
              );
            }
          }
          await this.touchSwapCheck(row.id, now, 0);
        }
      } else if (settlement === 'unknown') {
        for (const row of group) {
          await this.touchSwapCheck(row.id, now, 0);
          this.logger.warn(
            `Swap ${row.id} settlement unknown; leaving ${row.status}`,
          );
        }
      } else {
        for (const row of group) {
          const streak = nextExpiryStreak(
            settlement,
            row.expiresAt,
            now,
            expiryGraceMs,
            row.notFoundStreak,
          );
          if (shouldMarkExpired(streak)) {
            const { applied } = await this.swaps.finalizeExpired(
              row.id,
              row.consumer.apisixUsername,
            );
            await this.touchSwapCheck(row.id, now, streak);
            if (applied) {
              this.logger.log(`Expired swap ${row.id} (never settled)`);
            }
          } else {
            await this.touchSwapCheck(row.id, now, streak);
          }
        }
      }
    }
  }

  // ── Liquidity pool operations ──────────────────────────────────────────────
  private async reconcileLiquidity(batchSize: number): Promise<void> {
    const rows = await this.prisma.liquidityPoolOperation.findMany({
      where: { status: { in: ['PENDING', 'SUBMITTED'] } },
      include: { consumer: true },
      orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: batchSize,
    });
    const now = new Date();
    const { expiryGraceMs } = this.config.get('observer', { infer: true });
    for (const row of rows) {
      const settlement = await this.settlementOf(row.network, row.txHash);
      const username = row.consumer.apisixUsername;
      if (settlement === 'succeeded') {
        const { applied } = await this.liquidity.finalizeSucceeded(
          row.id,
          username,
        );
        await this.touchLpCheck(row.id, now, 0);
        if (applied) {
          this.logger.log(`Reconciled LP operation ${row.id} → SUCCEEDED`);
        }
      } else if (settlement === 'failed') {
        const { applied } = await this.liquidity.finalizeFailed(
          row.id,
          username,
        );
        await this.touchLpCheck(row.id, now, 0);
        if (applied) {
          this.logger.warn(`Reconciled LP operation ${row.id} → FAILED`);
        }
      } else if (settlement === 'unknown') {
        await this.touchLpCheck(row.id, now, 0);
        this.logger.warn(
          `LP operation ${row.id} settlement unknown; leaving ${row.status}`,
        );
      } else {
        const streak = nextExpiryStreak(
          settlement,
          row.expiresAt,
          now,
          expiryGraceMs,
          row.notFoundStreak,
        );
        if (shouldMarkExpired(streak)) {
          const { applied } = await this.liquidity.finalizeExpired(
            row.id,
            username,
          );
          await this.touchLpCheck(row.id, now, streak);
          if (applied) {
            this.logger.log(`Expired LP operation ${row.id} (never settled)`);
          }
        } else {
          await this.touchLpCheck(row.id, now, streak);
        }
      }
    }
  }

  /**
   * Re-checks EXPIRED rows from the last 24h against Horizon and corrects them
   * if the tx actually landed. Domain finalize* uses conditional updates so a
   * concurrent transition is not overwritten. Low frequency: at most once per
   * RESCUE_INTERVAL_MS.
   */
  private async maybeRescueExpired(batchSize: number): Promise<void> {
    if (Date.now() - this.lastRescueAt < RESCUE_INTERVAL_MS) return;
    this.lastRescueAt = Date.now();
    await this.rescueExpired(batchSize);
  }

  private async rescueExpired(batchSize: number): Promise<void> {
    const since = new Date(Date.now() - RESCUE_LOOKBACK_MS);
    const swaps = await this.prisma.swap.findMany({
      where: { status: 'EXPIRED', updatedAt: { gte: since } },
      include: { consumer: true },
      orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: batchSize,
    });
    const ops = await this.prisma.liquidityPoolOperation.findMany({
      where: { status: 'EXPIRED', updatedAt: { gte: since } },
      include: { consumer: true },
      orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: batchSize,
    });
    const now = new Date();
    for (const row of swaps) {
      const settlement = await this.settlementOf(row.network, row.txHash);
      const username = row.consumer.apisixUsername;
      if (settlement === 'succeeded') {
        const { applied } = await this.swaps.finalizeSucceeded(
          row.id,
          username,
        );
        await this.touchSwapCheck(row.id, now, 0);
        if (applied) {
          this.logger.log(`Rescued swap ${row.id} EXPIRED → SUCCEEDED`);
        }
      } else if (settlement === 'failed') {
        const { applied } = await this.swaps.finalizeFailed(row.id, username);
        await this.touchSwapCheck(row.id, now, 0);
        if (applied) {
          this.logger.log(`Rescued swap ${row.id} EXPIRED → FAILED`);
        }
      } else {
        await this.touchSwapCheck(row.id, now, row.notFoundStreak);
      }
    }
    for (const row of ops) {
      const settlement = await this.settlementOf(row.network, row.txHash);
      const username = row.consumer.apisixUsername;
      if (settlement === 'succeeded') {
        const { applied } = await this.liquidity.finalizeSucceeded(
          row.id,
          username,
        );
        await this.touchLpCheck(row.id, now, 0);
        if (applied) {
          this.logger.log(`Rescued LP operation ${row.id} EXPIRED → SUCCEEDED`);
        }
      } else if (settlement === 'failed') {
        const { applied } = await this.liquidity.finalizeFailed(
          row.id,
          username,
        );
        await this.touchLpCheck(row.id, now, 0);
        if (applied) {
          this.logger.log(`Rescued LP operation ${row.id} EXPIRED → FAILED`);
        }
      } else {
        await this.touchLpCheck(row.id, now, row.notFoundStreak);
      }
    }
  }

  private touchSwapCheck(
    id: string,
    lastCheckedAt: Date,
    notFoundStreak: number,
  ): Promise<unknown> {
    return this.prisma.swap.update({
      where: { id },
      data: { lastCheckedAt, notFoundStreak },
    });
  }

  private touchLpCheck(
    id: string,
    lastCheckedAt: Date,
    notFoundStreak: number,
  ): Promise<unknown> {
    return this.prisma.liquidityPoolOperation.update({
      where: { id },
      data: { lastCheckedAt, notFoundStreak },
    });
  }

  /**
   * Looks a transaction up by its deterministic hash on Horizon. Because signing
   * does not change the hash, a customer who signs and broadcasts the tx
   * themselves (bypassing our submit endpoint) still settles under this hash. A
   * 404 means it is not on-chain (`not_found`); 429/5xx are retried then reported
   * as `unknown` so we never expire on a Horizon blip.
   */
  private async settlementOf(
    network: string,
    txHash: string,
  ): Promise<Settlement> {
    for (let attempt = 1; attempt <= HORIZON_LOOKUP_ATTEMPTS; attempt++) {
      try {
        const tx = await this.stellar
          .server(network as StellarNetwork)
          .transactions()
          .transaction(txHash)
          .call();
        return tx.successful ? 'succeeded' : 'failed';
      } catch (err) {
        const status = horizonStatus(err);
        const message = horizonMessage(err);
        if (status === 404) {
          this.logger.log(`Horizon tx ${txHash} → not_found`);
          return 'not_found';
        }
        this.logger.warn(
          `Horizon lookup failed for tx ${txHash} (status=${status ?? 'none'}, ${message}) → unknown`,
        );
        const retryable = isRetryableHorizonStatus(status);
        if (retryable && attempt < HORIZON_LOOKUP_ATTEMPTS) {
          await wait(HORIZON_RETRY_BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }
        return 'unknown';
      }
    }
    return 'unknown';
  }
}

function horizonStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const response = (err as { response?: { status?: unknown } }).response;
  return typeof response?.status === 'number' ? response.status : undefined;
}

function horizonMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return String(err);
}

function isRetryableHorizonStatus(status: number | undefined): boolean {
  return (
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599)
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
