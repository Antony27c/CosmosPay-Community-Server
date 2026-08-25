import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig, StellarNetwork } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { armObserverWatchdog } from '../common/observer-watchdog';
import { horizonHttpStatus, StellarService } from '../stellar/stellar.service';
import { LiquidityPoolsService } from '../liquidity-pools/liquidity-pools.service';
import { SwapsService } from '../swaps/swaps.service';
import { nextExpiryStreak, shouldMarkExpired } from './settlement-expiry';

/** On-chain settlement of a stored transaction, keyed by its hash. */
type Settlement = 'succeeded' | 'failed' | 'not_found' | 'unknown';

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
  private cycleGeneration = 0;
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

  /** True while a reconciliation cycle is in flight. Exposed for tests. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * One settlement cycle. `running` normally prevents overlap; the watchdog
   * may still release it after 2× interval while a hung cycle is in flight,
   * so two ticks can then hit the same rows. Finalize paths must stay
   * idempotent (`applied` + quiet duplicate-hash helpers).
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const generation = ++this.cycleGeneration;
    const { batchSize, intervalMs } = this.config.get('observer', {
      infer: true,
    });
    const cancelWatchdog = armObserverWatchdog({
      logger: this.logger,
      name: 'Settlement observer',
      observer: 'settlement',
      stellar: this.stellar,
      intervalMs,
      generation,
      currentGeneration: () => this.cycleGeneration,
      setRunning: (value) => {
        this.running = value;
      },
    });
    const started = Date.now();
    let reconciled = 0;
    try {
      reconciled += await this.reconcileSwaps(batchSize);
      reconciled += await this.reconcileLiquidity(batchSize);
      await this.maybeRescueExpired(batchSize);
    } catch (err) {
      this.logger.error('Settlement observer cycle failed', err as Error);
    } finally {
      cancelWatchdog();
      const durationMs = Date.now() - started;
      this.stellar.recordObserverCycle('settlement', {
        durationMs,
        reconciled,
      });
      const { horizonErrors, observers } = this.stellar.metrics();
      this.logger.log(
        `Settlement cycle complete cycles=${observers.settlement.cycles} ` +
          `reconciled=${reconciled} durationMs=${durationMs} ` +
          `horizonErrors=${JSON.stringify(horizonErrors)}`,
      );
      if (this.cycleGeneration === generation) {
        this.running = false;
      }
    }
  }

  // ── Swaps ────────────────────────────────────────────────────────────────
  private async reconcileSwaps(batchSize: number): Promise<number> {
    const rows = await this.prisma.swap.findMany({
      where: { status: { in: ['PENDING', 'SUBMITTED'] } },
      include: { consumer: true },
      orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: batchSize,
    });
    const now = new Date();
    let reconciled = 0;
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
              reconciled += 1;
              this.logger.log(`Reconciled swap ${row.id} → SUCCEEDED`);
            }
          } else {
            // Duplicate hash: settle the phantom row without a second webhook.
            const { applied } = await this.swaps.finalizeSucceededQuiet(row.id);
            if (applied) {
              reconciled += 1;
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
              reconciled += 1;
              this.logger.warn(`Reconciled swap ${row.id} → FAILED`);
            }
          } else {
            const { applied } = await this.swaps.finalizeFailedQuiet(row.id);
            if (applied) {
              reconciled += 1;
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
    return reconciled;
  }

  // ── Liquidity pool operations ──────────────────────────────────────────────
  private async reconcileLiquidity(batchSize: number): Promise<number> {
    const rows = await this.prisma.liquidityPoolOperation.findMany({
      where: { status: { in: ['PENDING', 'SUBMITTED'] } },
      include: { consumer: true },
      orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: batchSize,
    });
    const now = new Date();
    let reconciled = 0;
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
          reconciled += 1;
          this.logger.log(`Reconciled LP operation ${row.id} → SUCCEEDED`);
        }
      } else if (settlement === 'failed') {
        const { applied } = await this.liquidity.finalizeFailed(
          row.id,
          username,
        );
        await this.touchLpCheck(row.id, now, 0);
        if (applied) {
          reconciled += 1;
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
    return reconciled;
  }

  /**
   * Re-checks EXPIRED rows whose tx timebounds fell in the last 24h and
   * corrects them if the tx actually landed. Domain finalize* uses conditional
   * updates so a concurrent transition is not overwritten. Low frequency: at
   * most once per RESCUE_INTERVAL_MS. The lookback is on expiresAt (immutable
   * after create) so a failed Horizon check never refreshes the window.
   */
  private async maybeRescueExpired(batchSize: number): Promise<void> {
    if (Date.now() - this.lastRescueAt < RESCUE_INTERVAL_MS) return;
    this.lastRescueAt = Date.now();
    await this.rescueExpired(batchSize);
  }

  private async rescueExpired(batchSize: number): Promise<void> {
    // Anchor on expiresAt (not updatedAt): touching lastCheckedAt would bump
    // @updatedAt and keep truly-dead EXPIRED rows inside the window forever.
    const since = new Date(Date.now() - RESCUE_LOOKBACK_MS);
    const swaps = await this.prisma.swap.findMany({
      where: { status: 'EXPIRED', expiresAt: { gte: since } },
      include: { consumer: true },
      orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: batchSize,
    });
    const ops = await this.prisma.liquidityPoolOperation.findMany({
      where: { status: 'EXPIRED', expiresAt: { gte: since } },
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
      }
      // not_found / unknown: leave the row alone so updatedAt (and the
      // expiresAt window) stay put — truly expired hashes age out after 24h.
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
   * Timeout/retry live in {@link StellarService.call}. This method only maps
   * the outcome: 404 → `not_found` (expiry streak), other failures → `unknown`
   * (do not expire on a Horizon blip).
   */
  private async settlementOf(
    network: string,
    txHash: string,
  ): Promise<Settlement> {
    try {
      const tx = await this.stellar.call(network as StellarNetwork, (server) =>
        server.transactions().transaction(txHash).call(),
      );
      return tx.successful ? 'succeeded' : 'failed';
    } catch (err) {
      const status = horizonHttpStatus(err);
      if (status === 404) {
        this.logger.log(`Horizon tx ${txHash} → not_found`);
        return 'not_found';
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Horizon lookup failed for tx ${txHash} (status=${status ?? 'none'}, ${message}) → unknown`,
      );
      return 'unknown';
    }
  }
}
