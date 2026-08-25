import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** How often expired previous secrets are nulled. */
const CLEANUP_INTERVAL_MS = 60_000;

/**
 * Nulls `previousSecret` once `previousSecretExpiresAt` has passed.
 *
 * Chosen over lazy cleanup (null on the next write) because there is no
 * retry worker to hang a write on, and an unused endpoint would otherwise
 * keep the old HMAC secret in the database indefinitely — extra attack
 * surface after the grace window the integrator already survived.
 *
 * Mirrors SettlementObserverService: re-entry guard, `unref` so the interval
 * never keeps the process alive, `clearInterval` on destroy.
 */
@Injectable()
export class WebhookSecretCleanupService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WebhookSecretCleanupService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    this.logger.log(
      `Webhook secret cleanup started (every ${CLEANUP_INTERVAL_MS}ms)`,
    );
    this.timer = setInterval(() => void this.tick(), CLEANUP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.prisma.webhookEndpoint.updateMany({
        where: {
          previousSecret: { not: null },
          previousSecretExpiresAt: { lte: new Date() },
        },
        data: {
          previousSecret: null,
          previousSecretExpiresAt: null,
        },
      });
      if (result.count > 0) {
        this.logger.log(
          `Cleared ${result.count} expired webhook previous secret(s)`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Webhook secret cleanup failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      this.running = false;
    }
  }
}
