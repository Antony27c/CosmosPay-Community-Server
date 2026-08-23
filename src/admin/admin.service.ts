import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiversService } from '../kyc/receivers/receivers.service';
import { RequestTosDto } from '../kyc/receivers/dto/request-tos.dto';
import type { AdminPrincipal } from './admin-auth';
import { toAuditData, recordAuditInTransaction } from './admin-audit.service';

/** Clamp a requested page size to a sane range. */
function take(n?: number): number {
  if (!n || n < 1) return 50;
  return Math.min(n, 200);
}
function skip(n?: number): number {
  return !n || n < 0 ? 0 : n;
}
function num(amount: string | null): number {
  if (!amount) return 0;
  const v = Number(amount);
  return Number.isFinite(v) ? v : 0;
}
function money(n: number): string {
  return Number(n.toFixed(7)).toString();
}
const consumerSelect = {
  consumer: { select: { apisixUsername: true, credentialId: true } },
};

/**
 * Platform-admin (owner) reads: the SAME data as the per-consumer services, but across
 * EVERY consumer/organization — no consumer scoping. Reached only via the AdminGuard
 * (Bearer credentials + roles, issue #34). Every list carries the owning consumer for attribution.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly receiversSvc: ReceiversService,
  ) {}

  /**
   * Platform-admin (owner) review of ANY pending receiver across consumers: approve it
   * (pending_review → pending_user) and return BlindPay's hosted terms url + the
   * customer's email so the dev platform sends the terms email. The org-scoped approve
   * only works for the owner's own org, so the global admin Fiat view needs this.
   * Local status write + audit row commit in one transaction.
   */
  async approveReceiver(
    id: string,
    redirectUrl: string,
    actor: AdminPrincipal,
  ) {
    return this.receiversSvc.approveById(
      id,
      redirectUrl,
      toAuditData(actor, 'receivers.approve', 'receiver', id, {
        redirect_url: redirectUrl,
      }),
    );
  }

  /** Platform-admin activation of ANY receiver across consumers (post terms acceptance). */
  async enableReceiver(id: string, tosId: string, actor: AdminPrincipal) {
    return this.receiversSvc.enableById(
      id,
      tosId,
      toAuditData(actor, 'receivers.enable', 'receiver', id, {
        tos_id: tosId,
      }),
    );
  }

  /**
   * Platform-admin resend of the terms-of-service link for ANY receiver across consumers.
   * The customer accepting these terms is what kicks off BlindPay verification, so the global
   * Admin → Fiat view uses this to re-send the verification email for a pending_user receiver.
   * Returns the ToS url + customer email so the dev platform sends the email (we have no mailer).
   */
  async requestReceiverTos(
    id: string,
    dto: RequestTosDto,
    actor: AdminPrincipal,
    cooldownMs?: number,
  ) {
    return this.receiversSvc.requestTosById(
      id,
      dto,
      cooldownMs,
      toAuditData(actor, 'receivers.requestTos', 'receiver', id, {
        channel: dto.channel ?? 'code',
        redirect_url: dto.redirect_url,
      }),
    );
  }

  /** Global, cross-consumer summary — the owner's "everything at a glance". */
  async summary(network?: string) {
    const netWhere = network ? { network } : {};

    const [
      consumers,
      customers,
      products,
      webhookEndpoints,
      intentsByStatus,
      swapsByStatus,
      receiversByStatus,
      payinsByStatus,
      payoutsByStatus,
      succeededIntents,
    ] = await Promise.all([
      this.prisma.consumer.count(),
      this.prisma.customer.count(),
      this.prisma.product.count(),
      this.prisma.webhookEndpoint.count(),
      this.prisma.paymentIntent.groupBy({
        by: ['status'],
        where: netWhere,
        _count: { _all: true },
      }),
      this.prisma.swap.groupBy({
        by: ['status'],
        where: netWhere,
        _count: { _all: true },
      }),
      this.prisma.blindpayReceiver.groupBy({
        by: ['kycStatus'],
        _count: { _all: true },
      }),
      this.prisma.payin.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.payout.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.paymentIntent.findMany({
        where: { status: 'SUCCEEDED', ...netWhere },
        select: { amount: true, asset: true },
      }),
    ]);

    // Settled volume per asset (succeeded payment intents).
    const volMap = new Map<string, { amount: number; count: number }>();
    for (const i of succeededIntents) {
      const key = !i.asset || i.asset === 'native' ? 'XLM' : i.asset;
      const cur = volMap.get(key) ?? { amount: 0, count: 0 };
      cur.amount += num(i.amount);
      cur.count += 1;
      volMap.set(key, cur);
    }
    const volume = [...volMap.entries()].map(([asset, v]) => ({
      asset,
      amount: money(v.amount),
      count: v.count,
    }));

    const tally = (
      rows: { _count: { _all: number } }[],
      key: 'status' | 'kycStatus',
    ): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const r of rows as unknown as Array<
        Record<string, unknown> & { _count: { _all: number } }
      >) {
        const k = (r[key] as string | null) ?? 'unknown';
        out[k] = (out[k] ?? 0) + r._count._all;
      }
      return out;
    };
    const sum = (m: Record<string, number>) =>
      Object.values(m).reduce((a, b) => a + b, 0);

    const paymentIntents = tally(intentsByStatus, 'status');
    const swaps = tally(swapsByStatus, 'status');
    const receivers = tally(receiversByStatus, 'kycStatus');
    const payins = tally(payinsByStatus, 'status');
    const payouts = tally(payoutsByStatus, 'status');

    return {
      network: network ?? 'all',
      consumers,
      customers,
      products,
      webhookEndpoints,
      paymentIntents: { total: sum(paymentIntents), byStatus: paymentIntents },
      swaps: { total: sum(swaps), byStatus: swaps },
      fiat: {
        receivers: { total: sum(receivers), byStatus: receivers },
        payins: { total: sum(payins), byStatus: payins },
        payouts: { total: sum(payouts), byStatus: payouts },
      },
      volume,
    };
  }

  /** Every consumer (organization key) with per-resource counts. */
  async consumers(t?: number, s?: number) {
    const where = {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.consumer.findMany({
        where,
        take: take(t),
        skip: skip(s),
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: {
              paymentIntents: true,
              swaps: true,
              products: true,
              customers: true,
              blindpayReceivers: true,
              payins: true,
              payouts: true,
              webhookEndpoints: true,
            },
          },
        },
      }),
      this.prisma.consumer.count({ where }),
    ]);
    return { data: rows, total, take: take(t), skip: skip(s) };
  }

  async paymentIntents(opts: ListOpts & { network?: string; status?: string }) {
    const where = {
      ...consumerWhere(opts.consumer),
      ...(opts.network ? { network: opts.network } : {}),
      ...(opts.status ? { status: opts.status as never } : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.paymentIntent.findMany({
        where,
        take: take(opts.take),
        skip: skip(opts.skip),
        orderBy: { createdAt: 'desc' },
        include: consumerSelect,
      }),
      this.prisma.paymentIntent.count({ where }),
    ]);
    return { data, total, take: take(opts.take), skip: skip(opts.skip) };
  }

  async swaps(opts: ListOpts & { network?: string; status?: string }) {
    const where = {
      ...consumerWhere(opts.consumer),
      ...(opts.network ? { network: opts.network } : {}),
      ...(opts.status ? { status: opts.status as never } : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.swap.findMany({
        where,
        take: take(opts.take),
        skip: skip(opts.skip),
        orderBy: { createdAt: 'desc' },
        include: consumerSelect,
      }),
      this.prisma.swap.count({ where }),
    ]);
    return { data, total, take: take(opts.take), skip: skip(opts.skip) };
  }

  async customers(opts: ListOpts = {}) {
    const where = consumerWhere(opts.consumer);
    const [data, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        where,
        take: take(opts.take),
        skip: skip(opts.skip),
        orderBy: { createdAt: 'desc' },
        include: consumerSelect,
      }),
      this.prisma.customer.count({ where }),
    ]);
    return { data, total, take: take(opts.take), skip: skip(opts.skip) };
  }

  async products(opts: ListOpts = {}) {
    const where = consumerWhere(opts.consumer);
    const [data, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        take: take(opts.take),
        skip: skip(opts.skip),
        orderBy: { createdAt: 'desc' },
        include: consumerSelect,
      }),
      this.prisma.product.count({ where }),
    ]);
    return { data, total, take: take(opts.take), skip: skip(opts.skip) };
  }

  async receivers(opts: ListOpts = {}) {
    const where = consumerWhere(opts.consumer);
    const [data, total] = await this.prisma.$transaction([
      this.prisma.blindpayReceiver.findMany({
        where,
        take: take(opts.take),
        skip: skip(opts.skip),
        orderBy: { createdAt: 'desc' },
        include: consumerSelect,
      }),
      this.prisma.blindpayReceiver.count({ where }),
    ]);
    return { data, total, take: take(opts.take), skip: skip(opts.skip) };
  }

  async payins(opts: ListOpts = {}) {
    const where = consumerWhere(opts.consumer);
    const [data, total] = await this.prisma.$transaction([
      this.prisma.payin.findMany({
        where,
        take: take(opts.take),
        skip: skip(opts.skip),
        orderBy: { createdAt: 'desc' },
        include: consumerSelect,
      }),
      this.prisma.payin.count({ where }),
    ]);
    return { data, total, take: take(opts.take), skip: skip(opts.skip) };
  }

  /**
   * Platform-admin fiat kill-switch across ANY consumer: enable/disable a receiver by id
   * without consumer scoping (the owner acts globally). Mirrors the per-org access toggle.
   * Mutation + audit row commit in one transaction (issue #34 / Gitar review).
   */
  async setReceiverAccess(
    id: string,
    disabled: boolean,
    actor: AdminPrincipal,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.blindpayReceiver.findUnique({ where: { id } });
      if (!row) throw new NotFoundException('Receiver not found');
      const result = await tx.blindpayReceiver.update({
        where: { id },
        data: { disabled },
        include: consumerSelect,
      });
      await recordAuditInTransaction(
        tx,
        toAuditData(actor, 'receivers.setAccess', 'receiver', id, {
          disabled,
        }),
      );
      return result;
    });
  }

  async payouts(opts: ListOpts = {}) {
    const where = consumerWhere(opts.consumer);
    const [data, total] = await this.prisma.$transaction([
      this.prisma.payout.findMany({
        where,
        take: take(opts.take),
        skip: skip(opts.skip),
        orderBy: { createdAt: 'desc' },
        include: consumerSelect,
      }),
      this.prisma.payout.count({ where }),
    ]);
    return { data, total, take: take(opts.take), skip: skip(opts.skip) };
  }
}

/** Shared list options: pagination + an optional owning-consumer filter (local id). */
interface ListOpts {
  consumer?: string;
  take?: number;
  skip?: number;
}

/** Where-clause fragment scoping to a single consumer (org), or `{}` for all. */
function consumerWhere(consumer?: string): { consumerId?: string } {
  return consumer ? { consumerId: consumer } : {};
}
