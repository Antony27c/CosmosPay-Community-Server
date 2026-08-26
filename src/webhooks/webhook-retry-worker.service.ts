import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import type {
  WebhookDelivery,
  WebhookEndpoint,
} from '../../generated/prisma/client';
import { computeWebhookBackoffMs } from './webhook-backoff';
import { mapWithConcurrency } from './map-with-concurrency';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

type DeliveryWithEndpoint = WebhookDelivery & { endpoint: WebhookEndpoint };

/**
 * Durable webhook delivery worker. Claims due PENDING/RETRYING rows from
 * Postgres, POSTs once, then reschedules or dead-letters. Same lifecycle as
 * SettlementObserverService: setInterval + unref, re-entry guard, tick
 * try/catch so a failed cycle never kills the timer.
 */
@Injectable()
export class WebhookRetryWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WebhookRetryWorkerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly dispatcher: WebhookDispatcherService,
  ) {}

  onModuleInit(): void {
    const { workerIntervalMs } = this.config.get('webhooks', { infer: true });
    this.logger.log(
      `Webhook retry worker started (every ${workerIntervalMs}ms)`,
    );
    this.timer = setInterval(() => void this.tick(), workerIntervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** True while a delivery cycle is in flight. Exposed for tests. */
  isRunning(): boolean {
    return this.running;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.processBatch();
    } catch (err) {
      this.logger.error('Webhook retry worker cycle failed', err as Error);
    } finally {
      this.running = false;
    }
  }

  private async processBatch(): Promise<void> {
    const { workerBatchSize, leaseMs, fanoutConcurrency } = this.config.get(
      'webhooks',
      { infer: true },
    );
    const now = new Date();
    const due = await this.prisma.webhookDelivery.findMany({
      where: {
        status: { in: ['PENDING', 'RETRYING'] },
        AND: [
          { OR: [{ nextAttemptAt: { lte: now } }, { nextAttemptAt: null }] },
          { OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        ],
      },
      include: { endpoint: true },
      orderBy: { createdAt: 'asc' },
      take: workerBatchSize,
    });

    if (due.length === 0) {
      return;
    }

    const leaseUntil = new Date(now.getTime() + leaseMs);
    await mapWithConcurrency(due, fanoutConcurrency, async (row) => {
      try {
        const claimed = await this.claim(row.id, now, leaseUntil);
        if (claimed.count !== 1) {
          return;
        }
        await this.deliverClaimed(row);
      } catch (err) {
        this.logger.error(
          `Webhook delivery ${row.id} failed unexpectedly: ${
            err instanceof Error ? err.message : err
          }`,
        );
        await this.releaseLease(row.id);
      }
    });
  }

  private claim(
    id: string,
    now: Date,
    leaseUntil: Date,
  ): Promise<{ count: number }> {
    return this.prisma.webhookDelivery.updateMany({
      where: {
        id,
        status: { in: ['PENDING', 'RETRYING'] },
        AND: [
          { OR: [{ nextAttemptAt: { lte: now } }, { nextAttemptAt: null }] },
          { OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        ],
      },
      data: { leaseUntil },
    });
  }

  private async releaseLease(id: string): Promise<void> {
    try {
      await this.prisma.webhookDelivery.update({
        where: { id },
        data: { leaseUntil: null },
      });
    } catch {
      // Row may already be terminal or gone; the lease will expire either way.
    }
  }

  private async deliverClaimed(row: DeliveryWithEndpoint): Promise<void> {
    const cfg = this.config.get('webhooks', { infer: true });
    const maxAttempts = row.maxAttempts || cfg.maxAttempts;
    const result = await this.dispatcher.attemptOnce(row.endpoint, row);
    const attempts = row.attempts + 1;
    const now = new Date();

    if (result.ok) {
      await this.prisma.webhookDelivery.update({
        where: { id: row.id },
        data: {
          status: 'SUCCEEDED',
          attempts,
          responseStatus: result.responseStatus,
          error: null,
          lastAttemptAt: now,
          nextAttemptAt: null,
          leaseUntil: null,
        },
      });
      this.logger.log(
        `Delivery ${row.id} to ${row.endpoint.url} succeeded after ${attempts} attempt(s)`,
      );
      return;
    }

    if (result.fatal || attempts >= maxAttempts) {
      await this.prisma.webhookDelivery.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          attempts,
          responseStatus: result.responseStatus,
          error: result.error,
          lastAttemptAt: now,
          nextAttemptAt: null,
          leaseUntil: null,
        },
      });
      this.logger.warn(
        `Delivery ${row.id} to ${row.endpoint.url} failed after ${attempts} attempt(s): ${result.error}`,
      );
      if (!result.fatal) {
        await this.maybePauseEndpoint(row.endpoint);
      }
      return;
    }

    const delay = computeWebhookBackoffMs(
      attempts,
      cfg.backoffMs,
      cfg.maxBackoffMs,
    );
    await this.prisma.webhookDelivery.update({
      where: { id: row.id },
      data: {
        status: 'RETRYING',
        attempts,
        responseStatus: result.responseStatus,
        error: result.error,
        lastAttemptAt: now,
        nextAttemptAt: new Date(now.getTime() + delay),
        leaseUntil: null,
      },
    });
    this.logger.warn(
      `Delivery ${row.id} to ${row.endpoint.url} attempt ${attempts}/${maxAttempts} failed (${result.error}); retrying in ${delay}ms`,
    );
  }

  private async maybePauseEndpoint(endpoint: WebhookEndpoint): Promise<void> {
    if (!endpoint.enabled) {
      return;
    }
    const { pauseAfterFailures } = this.config.get('webhooks', {
      infer: true,
    });
    const recent = await this.prisma.webhookDelivery.findMany({
      where: {
        endpointId: endpoint.id,
        status: { in: ['SUCCEEDED', 'FAILED'] },
      },
      orderBy: { lastAttemptAt: { sort: 'desc', nulls: 'last' } },
      take: pauseAfterFailures,
      select: { status: true },
    });
    if (
      recent.length < pauseAfterFailures ||
      recent.some((d) => d.status !== 'FAILED')
    ) {
      return;
    }
    await this.prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { enabled: false },
    });
    this.logger.error(
      `Paused webhook endpoint ${endpoint.id} (${endpoint.url}) after ${pauseAfterFailures} consecutive delivery failure(s)`,
    );
  }
}
