import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
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

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly verifier: StellarVerifierService,
    private readonly paymentIntents: PaymentIntentsService,
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

  /** One reconciliation cycle. Guarded so cycles never overlap. */
  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const { batchSize } = this.config.get('observer', { infer: true });

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
        await this.reconcile(intent).catch((err) => {
          this.logger.error(
            `Reconcile failed for intent ${intent.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
    } catch (err) {
      this.logger.error(
        `Observer cycle failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async reconcile(
    intent: Awaited<
      ReturnType<PrismaService['paymentIntent']['findMany']>
    >[number] & { consumer: { apisixUsername: string } },
  ): Promise<void> {
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
    }
  }
}
