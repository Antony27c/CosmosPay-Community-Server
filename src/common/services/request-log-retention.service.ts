import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Background prune for `request_log`. The table is append-only (written by
 * LoggingInterceptor) and holds payer IP / user-agent; without retention it
 * grows forever and the dashboard "API logs" query degrades with volume.
 *
 * Mirrors SettlementObserverService: fixed interval, no overlapping cycles,
 * `unref` so the timer never keeps the process alive, clearInterval on destroy.
 */
@Injectable()
export class RequestLogRetentionService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RequestLogRetentionService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    const { retentionDays, pruneIntervalMs } = this.config.get(
      'requestLogRetention',
      { infer: true },
    );
    if (retentionDays <= 0) {
      this.logger.log(
        'Request log retention disabled (REQUEST_LOG_RETENTION_DAYS=0)',
      );
      return;
    }
    this.logger.log(
      `Request log retention started (keep ${retentionDays}d, every ${pruneIntervalMs}ms)`,
    );
    this.timer = setInterval(() => void this.tick(), pruneIntervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { retentionDays, batchSize } = this.config.get(
        'requestLogRetention',
        { infer: true },
      );
      if (retentionDays <= 0) return;

      const cutoff = new Date(
        Date.now() - retentionDays * 24 * 60 * 60 * 1000,
      );
      // deleteMany has no take — select a bounded id set first, then delete.
      const stale = await this.prisma.requestLog.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: batchSize,
      });
      if (stale.length === 0) return;

      const result = await this.prisma.requestLog.deleteMany({
        where: { id: { in: stale.map((r) => r.id) } },
      });
      this.logger.log(
        `Request log prune deleted ${result.count} row(s) older than ${cutoff.toISOString()}`,
      );
    } catch (err) {
      this.logger.error('Request log retention cycle failed', err as Error);
    } finally {
      this.running = false;
    }
  }
}
