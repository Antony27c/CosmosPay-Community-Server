import { Injectable } from '@nestjs/common';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { PrismaService } from '../prisma/prisma.service';
import type {
  PaymentIntent,
  PaymentIntentStatus,
} from '../../generated/prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse a decimal amount string to a number for aggregation (0 when absent). */
function num(amount: string | null): number {
  if (!amount) return 0;
  const n = Number(amount);
  return Number.isFinite(n) ? n : 0;
}

/** Round to 7 decimals (Stellar precision) and drop trailing zeros. */
function money(n: number): string {
  return Number(n.toFixed(7)).toString();
}

function assetLabel(asset: string): string {
  return !asset || asset === 'native' ? 'XLM' : asset;
}

/**
 * Read-only aggregates derived from the consumer's existing payment intents and
 * webhook deliveries — no separate analytics store. Powers the dashboard's
 * Overview, Balances, Customers and Logs views.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Mirror the APISIX consumer locally (and return null if it has no records yet). */
  private async resolveConsumerId(consumer: GatewayConsumer): Promise<string> {
    const local = await this.prisma.consumer.upsert({
      where: { apisixUsername: consumer.username },
      create: {
        apisixUsername: consumer.username,
        credentialId: consumer.credentialId,
      },
      update: { credentialId: consumer.credentialId },
    });
    return local.id;
  }

  /**
   * Stellar network the caller is scoped to, from the forwarded API key env:
   * `prod` → public, otherwise testnet. Every payment metric is filtered by this
   * so the dashboard's testnet vs mainnet views show distinct numbers.
   */
  private network(consumer: GatewayConsumer): string {
    return consumer.environment === 'prod' ? 'public' : 'testnet';
  }

  // ── Overview summary ────────────────────────────────────────────────────────
  async summary(consumer: GatewayConsumer) {
    const consumerId = await this.resolveConsumerId(consumer);
    const network = this.network(consumer);

    const intents = await this.prisma.paymentIntent.findMany({
      where: { consumerId, network },
      select: {
        id: true,
        kind: true,
        status: true,
        amount: true,
        asset: true,
        source: true,
        destination: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const byStatus: Record<string, number> = {};
    for (const i of intents) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;

    const succeeded = intents.filter((i) => i.status === 'SUCCEEDED');
    const total = intents.length;
    const successRate = total
      ? Math.round((succeeded.length / total) * 1000) / 10
      : 0;

    // Gross settled volume per asset (succeeded intents).
    const volumeMap = new Map<string, { amount: number; count: number }>();
    for (const i of succeeded) {
      const key = assetLabel(i.asset);
      const cur = volumeMap.get(key) ?? { amount: 0, count: 0 };
      cur.amount += num(i.amount);
      cur.count += 1;
      volumeMap.set(key, cur);
    }
    const volume = [...volumeMap.entries()].map(([asset, v]) => ({
      asset,
      amount: money(v.amount),
      count: v.count,
    }));

    // 30-day daily series (count + settled volume) for the sparklines.
    const start = Date.now() - 29 * DAY_MS;
    const series: { date: string; count: number; volume: string }[] = [];
    for (let d = 0; d < 30; d++) {
      const day = new Date(start + d * DAY_MS);
      const key = day.toISOString().slice(0, 10);
      series.push({ date: key, count: 0, volume: '0' });
    }
    const indexByDate = new Map(series.map((s, idx) => [s.date, idx]));
    for (const i of intents) {
      const key = i.createdAt.toISOString().slice(0, 10);
      const idx = indexByDate.get(key);
      if (idx === undefined) continue;
      series[idx].count += 1;
      if (i.status === 'SUCCEEDED') {
        series[idx].volume = money(num(series[idx].volume) + num(i.amount));
      }
    }

    // Webhook health.
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { consumerId },
      select: { id: true },
    });
    const endpointIds = endpoints.map((e) => e.id);
    const [deliveries, failedDeliveries] = await Promise.all([
      endpointIds.length
        ? this.prisma.webhookDelivery.count({
            where: { endpointId: { in: endpointIds } },
          })
        : Promise.resolve(0),
      endpointIds.length
        ? this.prisma.webhookDelivery.count({
            where: { endpointId: { in: endpointIds }, status: 'FAILED' },
          })
        : Promise.resolve(0),
    ]);

    const distinctPayers = new Set(
      intents.map((i) => i.source).filter((s): s is string => !!s),
    );

    return {
      totals: {
        all: total,
        succeeded: succeeded.length,
        pending: byStatus['PENDING'] ?? 0,
        submitted: byStatus['SUBMITTED'] ?? 0,
        failed: byStatus['FAILED'] ?? 0,
        cancelled: byStatus['CANCELLED'] ?? 0,
        expired: byStatus['EXPIRED'] ?? 0,
        successRate,
      },
      volume,
      webhooks: {
        endpoints: endpoints.length,
        deliveries,
        failedDeliveries,
      },
      customers: distinctPayers.size,
      series,
      recent: succeeded.slice(0, 6).map((i) => this.recentRow(i)),
    };
  }

  private recentRow(i: {
    id: string;
    kind: string;
    status: PaymentIntentStatus;
    amount: string | null;
    asset: string;
    destination: string;
    createdAt: Date;
  }) {
    return {
      id: i.id,
      kind: i.kind,
      status: i.status,
      amount: i.amount,
      asset: assetLabel(i.asset),
      destination: i.destination,
      createdAt: i.createdAt,
    };
  }

  // ── Balances (settled per asset) ────────────────────────────────────────────
  async balances(consumer: GatewayConsumer) {
    const consumerId = await this.resolveConsumerId(consumer);
    const network = this.network(consumer);
    const intents = await this.prisma.paymentIntent.findMany({
      where: { consumerId, network },
      select: { amount: true, asset: true, status: true },
    });

    const map = new Map<
      string,
      { settled: number; pending: number; settledCount: number }
    >();
    for (const i of intents) {
      const key = assetLabel(i.asset);
      const cur = map.get(key) ?? { settled: 0, pending: 0, settledCount: 0 };
      if (i.status === 'SUCCEEDED') {
        cur.settled += num(i.amount);
        cur.settledCount += 1;
      } else if (i.status === 'PENDING' || i.status === 'SUBMITTED') {
        cur.pending += num(i.amount);
      }
      map.set(key, cur);
    }

    const data = [...map.entries()]
      .map(([asset, v]) => ({
        asset,
        amount: money(v.settled),
        pending: money(v.pending),
        count: v.settledCount,
      }))
      .sort((a, b) => num(b.amount) - num(a.amount));

    return { data, total: data.length };
  }

  // ── API request logs (real inbound requests, with details) ──────────────────
  async apiLogs(consumer: GatewayConsumer, take = 100) {
    // RequestLog is keyed by the forwarded consumer username (not the local id).
    const where = { consumer: consumer.username };
    const [rows, total] = await Promise.all([
      this.prisma.requestLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
      }),
      this.prisma.requestLog.count({ where }),
    ]);
    const data = rows.map((r) => ({
      id: r.id,
      method: r.method,
      path: r.path,
      statusCode: r.statusCode,
      durationMs: r.durationMs,
      ip: r.ip,
      userAgent: r.userAgent,
      status:
        r.statusCode < 400 ? 'ok' : r.statusCode < 500 ? 'pending' : 'fail',
      at: r.createdAt,
    }));
    return { data, total };
  }

  // ── Webhook delivery logs (across all the consumer's endpoints) ──────────────
  async webhookLogs(consumer: GatewayConsumer, take = 100) {
    const consumerId = await this.resolveConsumerId(consumer);
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { consumerId },
      select: { id: true, url: true },
    });
    if (!endpoints.length) return { data: [], total: 0 };

    const urlById = new Map(endpoints.map((e) => [e.id, e.url]));
    const deliveries = await this.prisma.webhookDelivery.findMany({
      where: { endpointId: { in: endpoints.map((e) => e.id) } },
      orderBy: { createdAt: 'desc' },
      take,
    });

    const data = deliveries.map((d) => ({
      id: d.id,
      endpointId: d.endpointId,
      url: urlById.get(d.endpointId) ?? null,
      eventType: d.eventType,
      eventId: d.eventId,
      attempts: d.attempts,
      responseStatus: d.responseStatus,
      error: d.error,
      status:
        d.status === 'SUCCEEDED'
          ? 'ok'
          : d.status === 'FAILED'
            ? 'fail'
            : 'pending',
      at: d.lastAttemptAt ?? d.createdAt,
    }));
    return { data, total: data.length };
  }
}
