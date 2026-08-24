import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { armObserverWatchdog } from '../common/observer-watchdog';
import { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { PaymentIntentsService } from './payment-intents.service';
import { StellarVerifierService } from './stellar-verifier.service';

/**
 * Permanent on-chain observer. On a fixed interval it pulls PENDING intents and
 * asks the verifier whether a matching payment has landed — by the reported
 * txHash when present, otherwise by scanning payments to the destination. On a
 * confirmed match it finalizes the intent (status + txHash) and the webhook
 * event fires automatically, so integrators are notified without polling us.
 *
 * Polling (vs Horizon SSE streaming) is intentional: it survives restarts with
 * no cursor/reconnect bookkeeping and naturally picks up newly-created intents.
 */
@Injectable()
export class StellarObserverService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StellarObserverService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private cycleGeneration = 0;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly verifier: StellarVerifierService,
    private readonly paymentIntents: PaymentIntentsService,
    private readonly stellar: StellarService,
  ) {}

  onModuleInit(): void {
    const { enabled, intervalMs } = this.config.get('observer', {
      infer: true,
    });
    if (!enabled) {
      this.logger.log('On-chain observer disabled (OBSERVER_ENABLED=false)');
      return;
    }
    this.logger.log(`On-chain observer started (every ${intervalMs}ms)`);
    // `unref` so the interval never keeps the process alive on its own.
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /** True while a reconciliation cycle is in flight. Exposed for tests. */
  isRunning(): boolean {
    return this.running;
  }

  /** One reconciliation cycle. Guarded so cycles never overlap. */
  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    const generation = ++this.cycleGeneration;
    const { batchSize, intervalMs } = this.config.get('observer', {
      infer: true,
    });
    const cancelWatchdog = armObserverWatchdog({
      logger: this.logger,
      name: 'Payment-intent observer',
      observer: 'payment-intents',
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
      // 1. Expire unpaid intents past their lifetime.
      const expired = await this.prisma.paymentIntent.findMany({
        where: {
          status: { in: ['PENDING', 'SUBMITTED'] },
          expiresAt: { not: null, lt: new Date() },
        },
        include: { consumer: true },
        take: batchSize,
      });
      for (const intent of expired) {
        await this.paymentIntents
          .markExpired(intent.id, intent.consumer.apisixUsername)
          .catch((err) =>
            this.logger.error(
              `Expire failed for intent ${intent.id}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      }

      // 2. Reconcile still-pending intents against the chain.
      const pending = await this.prisma.paymentIntent.findMany({
        where: { status: 'PENDING' },
        include: { consumer: true },
        orderBy: { createdAt: 'asc' },
        take: batchSize,
      });

      for (const intent of pending) {
        try {
          if (await this.reconcile(intent)) {
            reconciled += 1;
          }
        } catch (err) {
          this.logger.error(
            `Reconcile failed for intent ${intent.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `Observer cycle failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      cancelWatchdog();
      const durationMs = Date.now() - started;
      this.stellar.recordObserverCycle('payment-intents', {
        durationMs,
        reconciled,
      });
      const { horizonErrors, observers } = this.stellar.metrics();
      this.logger.log(
        `Observer cycle complete cycles=${observers['payment-intents'].cycles} ` +
          `reconciled=${reconciled} durationMs=${durationMs} ` +
          `horizonErrors=${JSON.stringify(horizonErrors)}`,
      );
      if (this.cycleGeneration === generation) {
        this.running = false;
      }
    }
  }

  private async reconcile(
    intent: Awaited<
      ReturnType<PrismaService['paymentIntent']['findMany']>
    >[number] & { consumer: { apisixUsername: string } },
  ): Promise<boolean> {
    // Prefer the precise path when a hash was reported; otherwise scan.
    const result = intent.txHash
      ? await this.verifier.verifyByHash(intent, intent.txHash)
      : await this.verifier.findMatchingPayment(intent);

    if (result.valid && result.txHash) {
      await this.paymentIntents.markSucceeded(
        intent.id,
        intent.consumer.apisixUsername,
        result.txHash,
        result.payer,
        'observer',
      );
      return true;
    }
    return false;
  }
}
