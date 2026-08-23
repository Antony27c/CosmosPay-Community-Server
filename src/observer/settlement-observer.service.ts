import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppConfig, StellarNetwork } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { LiquidityPoolsService } from '../liquidity-pools/liquidity-pools.service';
import { WEBHOOK_EVENT, WebhookEventPayload } from '../webhooks/webhook-events';
import type { WebhookEventType } from '../../generated/prisma/client';

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
 */
@Injectable()
export class SettlementObserverService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SettlementObserverService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly events: EventEmitter2,
    private readonly liquidity: LiquidityPoolsService,
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
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });
    const now = new Date();
    for (const row of rows) {
      const settlement = await this.settlementOf(row.network, row.txHash);
      const username = row.consumer.apisixUsername;
      if (settlement === 'succeeded') {
        const updated = await this.prisma.swap.update({
          where: { id: row.id },
          data: { status: 'SUCCEEDED' },
        });
        this.emit(username, 'SWAP_SUCCEEDED', updated);
        this.logger.log(`Reconciled swap ${row.id} → SUCCEEDED`);
      } else if (settlement === 'failed') {
        const updated = await this.prisma.swap.update({
          where: { id: row.id },
          data: { status: 'FAILED' },
        });
        this.emit(username, 'SWAP_FAILED', updated);
        this.logger.warn(`Reconciled swap ${row.id} → FAILED`);
      } else if (row.expiresAt && row.expiresAt < now) {
        // Never settled and the tx timebounds have lapsed — it can no longer land.
        await this.prisma.swap.update({
          where: { id: row.id },
          data: { status: 'EXPIRED' },
        });
        this.logger.log(`Expired swap ${row.id} (never settled)`);
      }
    }
  }

  // ── Liquidity pool operations ──────────────────────────────────────────────
  private async reconcileLiquidity(batchSize: number): Promise<void> {
    const rows = await this.prisma.liquidityPoolOperation.findMany({
      where: { status: { in: ['PENDING', 'SUBMITTED'] } },
      include: { consumer: true },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });
    const now = new Date();
    for (const row of rows) {
      const settlement = await this.settlementOf(row.network, row.txHash);
      const username = row.consumer.apisixUsername;
      if (settlement === 'succeeded') {
        const { applied } = await this.liquidity.finalizeSucceeded(
          row.id,
          username,
        );
        if (applied) {
          this.logger.log(`Reconciled LP operation ${row.id} → SUCCEEDED`);
        }
      } else if (settlement === 'failed') {
        const { applied } = await this.liquidity.finalizeFailed(
          row.id,
          username,
        );
        if (applied) {
          this.logger.warn(`Reconciled LP operation ${row.id} → FAILED`);
        }
      } else if (row.expiresAt && row.expiresAt < now) {
        const { applied } = await this.liquidity.finalizeExpired(row.id);
        if (applied) {
          this.logger.log(`Expired LP operation ${row.id} (never settled)`);
        }
      }
    }
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
      const tx = await this.stellar
        .server(network as StellarNetwork)
        .transactions()
        .transaction(txHash)
        .call();
      return tx.successful ? 'succeeded' : 'failed';
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      if (status === 404) return 'unsettled';
      this.logger.warn(`Horizon lookup failed for tx ${txHash}`);
      return 'unsettled';
    }
  }

  private emit(username: string, type: WebhookEventType, data: unknown): void {
    this.events.emit(
      WEBHOOK_EVENT,
      new WebhookEventPayload(username, type, data),
    );
  }
}
