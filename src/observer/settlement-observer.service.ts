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

/** On-chain settlement of a stored transaction, keyed by its hash. */
type Settlement = 'succeeded' | 'failed' | 'unsettled';

/**
 * Permanent settlement observer for swaps and liquidity pool operations. Both
 * are non-custodial: the customer signs and broadcasts the transaction we built,
 * and may do so **without** calling our submit endpoint (e.g. straight from their
 * wallet via the SEP-7 link). Signing does not change the transaction hash, so on
 * a fixed interval we look each PENDING/SUBMITTED row up on Horizon **by its
 * stored txHash** and finalize it — SUCCEEDED / FAILED (with the matching webhook
 * event) or EXPIRED once its timebounds lapse. Mirrors the payment-intent
 * observer; polling survives restarts with no cursor bookkeeping.
 *
 * Observer never emits webhooks itself. Terminal events are a consequence of
 * winning `finalizeSucceeded` / `finalizeFailed` on the domain service — the
 * same functions submit uses — so a parallel observer+submit race produces one
 * event, not two.
 */
@Injectable()
export class SettlementObserverService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SettlementObserverService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private cycleGeneration = 0;

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

  /** One settlement cycle. Guarded so cycles never overlap. */
  async tick(): Promise<void> {
    if (this.running) return; // never overlap cycles
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
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });
    const now = new Date();
    let reconciled = 0;
    for (const row of rows) {
      const settlement = await this.settlementOf(row.network, row.txHash);
      const username = row.consumer.apisixUsername;
      if (settlement === 'succeeded') {
        const { applied } = await this.swaps.finalizeSucceeded(
          row.id,
          username,
        );
        if (applied) {
          reconciled += 1;
          this.logger.log(`Reconciled swap ${row.id} → SUCCEEDED`);
        }
      } else if (settlement === 'failed') {
        const { applied } = await this.swaps.finalizeFailed(row.id, username);
        if (applied) {
          reconciled += 1;
          this.logger.warn(`Reconciled swap ${row.id} → FAILED`);
        }
      } else if (row.expiresAt && row.expiresAt < now) {
        const { applied } = await this.swaps.finalizeExpired(row.id);
        if (applied) {
          this.logger.log(`Expired swap ${row.id} (never settled)`);
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
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });
    const now = new Date();
    let reconciled = 0;
    for (const row of rows) {
      const settlement = await this.settlementOf(row.network, row.txHash);
      const username = row.consumer.apisixUsername;
      if (settlement === 'succeeded') {
        const { applied } = await this.liquidity.finalizeSucceeded(
          row.id,
          username,
        );
        if (applied) {
          reconciled += 1;
          this.logger.log(`Reconciled LP operation ${row.id} → SUCCEEDED`);
        }
      } else if (settlement === 'failed') {
        const { applied } = await this.liquidity.finalizeFailed(
          row.id,
          username,
        );
        if (applied) {
          reconciled += 1;
          this.logger.warn(`Reconciled LP operation ${row.id} → FAILED`);
        }
      } else if (row.expiresAt && row.expiresAt < now) {
        const { applied } = await this.liquidity.finalizeExpired(row.id);
        if (applied) {
          this.logger.log(`Expired LP operation ${row.id} (never settled)`);
        }
      }
    }
    return reconciled;
  }

  /**
   * Looks a transaction up by its deterministic hash on Horizon. Because signing
   * does not change the hash, a customer who signs and broadcasts the tx
   * themselves (bypassing our submit endpoint) still settles under this hash. A
   * 404 means it is simply not on-chain yet; any other Horizon error is treated
   * as transient and retried next cycle.
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
      if (horizonHttpStatus(err) === 404) return 'unsettled';
      this.logger.warn(`Horizon lookup failed for tx ${txHash}`);
      return 'unsettled';
    }
  }
}
