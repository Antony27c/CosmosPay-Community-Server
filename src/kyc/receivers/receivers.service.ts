import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { GatewayConsumer } from '../../common/interfaces/gateway-consumer.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { BlindpayClient } from '../../blindpay/blindpay.client';
import { ConsumerResolverService } from '../../blindpay/consumer-resolver.service';
import {
  BlindpaySyncService,
  BlindpayObject,
} from '../../blindpay/blindpay-sync.service';
import { asString, toJson } from '../../blindpay/blindpay.util';
import type { BlindpayReceiver } from '../../../generated/prisma/client';
import type { AdminAuditData } from '../../admin/admin-audit.service';
import { recordAuditInTransaction } from '../../admin/admin-audit.service';
import { CreateReceiverDto } from './dto/create-receiver.dto';
import { UpdateReceiverDto } from './dto/update-receiver.dto';
import { RequestTosDto } from './dto/request-tos.dto';

/** Local placeholder id for a receiver that doesn't exist at BlindPay yet. */
const LOCAL_PREFIX = 'local_';
const TOS_EMAIL_COOLDOWN_MS = 24 * 60 * 60 * 1000; // once per day

/**
 * Manages BlindPay receivers (the KYC/KYB entities) on behalf of a consumer.
 * Creates/updates go to BlindPay and are mirrored locally; reads come from the
 * mirror, with single-receiver reads refreshed from BlindPay so the KYC status
 * is current. Every row is scoped to the calling consumer.
 */
@Injectable()
export class ReceiversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blindpay: BlindpayClient,
    private readonly consumers: ConsumerResolverService,
    private readonly sync: BlindpaySyncService,
  ) {}

  /**
   * Creates a receiver. We don't call BlindPay yet (it needs an accepted `tos_id`, and
   * the terms are only sent after our review). The lifecycle lives in `kycStatus`:
   *   inactive       → only the registration request exists (no KYC data yet)
   *   pending_review → KYC data uploaded, awaiting OUR (owner/admin) review
   *   pending_user   → we approved it; the customer must accept BlindPay's terms
   *   <BlindPay's>   → once the customer accepts, the receiver is created at BlindPay
   *                    and `kycStatus` becomes BlindPay's own (verifying/approved/…)
   * A create that carries KYC data lands in `pending_review`; a bare registration in
   * `inactive`. The full payload is stored so {@link enable} can replay it to BlindPay.
   */
  async create(consumer: GatewayConsumer, dto: CreateReceiverDto) {
    const local = await this.consumers.resolve(consumer);
    return this.prisma.blindpayReceiver.create({
      data: {
        consumerId: local.id,
        // Placeholder until the real `re_...` id is assigned on enable().
        blindpayId: `${LOCAL_PREFIX}${randomUUID()}`,
        type: dto.type,
        kycType: dto.kyc_type,
        kycStatus: hasKycData(dto) ? 'pending_review' : 'inactive',
        email: dto.email,
        name: receiverName(dto),
        country: dto.country,
        externalId: dto.external_id ?? null,
        // Keep the full create payload so enable() can replay it to BlindPay.
        raw: toJson({ ...dto }),
      },
    });
  }

  /**
   * OUR review gate: a platform owner/admin (enforced upstream by the dashboard, which
   * is the only caller that knows the org-member role) approves a `pending_review`
   * receiver. Only then do we send the customer BlindPay's terms-of-service link. Moves
   * the receiver to `pending_user` and returns the hosted ToS url + email so the caller
   * delivers it. The real KYC approval still comes from BlindPay afterwards.
   */
  async approve(
    consumer: GatewayConsumer,
    id: string,
    redirectUrl: string,
  ): Promise<{
    receiver: BlindpayReceiver;
    url: string;
    email: string | null;
  }> {
    const local = await this.consumers.resolve(consumer);
    // Ownership check (404 if the receiver isn't this consumer's) then the shared logic.
    await this.findReceiverOrThrow(local.id, id);
    return this.approveById(id, redirectUrl);
  }

  /**
   * Approve a receiver BY LOCAL ID across any consumer — the platform-admin (owner)
   * variant of {@link approve}. Skips consumer scoping; the AdminGuard authorizes it.
   * When `audit` is provided, the local status write and the audit row commit together.
   */
  async approveById(
    id: string,
    redirectUrl: string,
    audit?: AdminAuditData,
  ): Promise<{
    receiver: BlindpayReceiver;
    url: string;
    email: string | null;
  }> {
    const row = await this.prisma.blindpayReceiver.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('Receiver not found');
    if (row.kycStatus !== 'pending_review') {
      throw new BadRequestException(
        `Receiver must be pending review to approve (current: ${row.kycStatus ?? 'unknown'}).`,
      );
    }
    // BlindPay side-effect cannot join the DB transaction; local write + audit can.
    const url = await this.tosUrl(redirectUrl, row);
    return this.prisma.$transaction(async (tx) => {
      const receiver = await tx.blindpayReceiver.update({
        where: { id: row.id },
        data: { kycStatus: 'pending_user', tosSentAt: new Date() },
      });
      if (audit) {
        await recordAuditInTransaction(tx, audit);
      }
      return { receiver, url, email: row.email };
    });
  }

  /** Requests BlindPay's hosted ToS acceptance url for a receiver. */
  private async tosUrl(
    redirectUrl: string,
    row: BlindpayReceiver,
  ): Promise<string> {
    const isLocal = row.blindpayId.startsWith(LOCAL_PREFIX);
    const { url } = await this.blindpay.post<{ url: string }>(
      `/e/instances/${this.blindpay.instanceId}/tos`,
      {
        idempotency_key: randomUUID(),
        // Only reference an existing BlindPay receiver; a brand-new (local) one has none.
        receiver_id: isLocal ? null : row.blindpayId,
        redirect_url: redirectUrl,
      },
    );
    return url;
  }

  /**
   * Returns a terms-of-service acceptance link for a receiver (BlindPay's hosted
   * flow). The end user accepts it and is redirected back with a `tos_id` that
   * {@link enable} then submits. `channel: 'email'` records the send so it can't be
   * triggered more than once per day; the actual email is sent by the caller (the
   * dashboard) using the returned url + the receiver's email.
   */
  async requestTos(
    consumer: GatewayConsumer,
    id: string,
    dto: RequestTosDto,
    cooldownMs?: number,
  ): Promise<{ url: string; email: string | null; channel: 'code' | 'email' }> {
    const local = await this.consumers.resolve(consumer);
    // Ownership check (404 if the receiver isn't this consumer's) then the shared logic.
    await this.findReceiverOrThrow(local.id, id);
    return this.requestTosById(id, dto, cooldownMs);
  }

  /**
   * Resend the terms-of-service link for a receiver BY LOCAL ID across any consumer — the
   * platform-admin (owner) variant of {@link requestTos}. Skips consumer scoping; the
   * AdminGuard authorizes it. Same gate as the org-scoped path: the receiver must be
   * `pending_user`. The email channel is rate-limited; the default is once per day, but a
   * trusted dashboard caller may shorten it per the requester's role (`cooldownMs`) — owners
   * resend immediately (0), admins every minute. External API keys never set this (the marker
   * header is stripped by APISIX), so they always get the default cooldown.
   * When `audit` is provided, any local write and the audit row commit together.
   */
  async requestTosById(
    id: string,
    dto: RequestTosDto,
    cooldownMs?: number,
    audit?: AdminAuditData,
  ): Promise<{ url: string; email: string | null; channel: 'code' | 'email' }> {
    const row = await this.prisma.blindpayReceiver.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('Receiver not found');
    // Terms are only (re)sent after our owner/admin review has approved the receiver.
    if (row.kycStatus !== 'pending_user') {
      throw new BadRequestException(
        'Terms of service can only be sent after the receiver has been approved.',
      );
    }
    const channel = dto.channel ?? 'code';
    const cooldown =
      cooldownMs !== undefined && Number.isFinite(cooldownMs) && cooldownMs >= 0
        ? cooldownMs
        : TOS_EMAIL_COOLDOWN_MS;

    if (
      channel === 'email' &&
      cooldown > 0 &&
      row.tosSentAt &&
      Date.now() - row.tosSentAt.getTime() < cooldown
    ) {
      throw new BadRequestException(
        'A terms-of-service email was already sent for this receiver recently. Please wait before resending.',
      );
    }

    // BlindPay side-effect first; local write + audit are transactional.
    const url = await this.tosUrl(dto.redirect_url, row);

    return this.prisma.$transaction(async (tx) => {
      if (channel === 'email') {
        await tx.blindpayReceiver.update({
          where: { id: row.id },
          data: { tosSentAt: new Date() },
        });
      }
      if (audit) {
        await recordAuditInTransaction(tx, audit);
      }
      return { url, email: row.email, channel };
    });
  }

  /**
   * Activates an inactive receiver: replays the stored registration payload to
   * BlindPay together with the accepted `tos_id`, then upgrades the local row in
   * place (placeholder id → real `re_...` id, status → BlindPay's). Idempotent —
   * an already-active receiver is just refreshed.
   */
  async enable(consumer: GatewayConsumer, id: string, tosId: string) {
    const local = await this.consumers.resolve(consumer);
    // Ownership check (404 if not this consumer's) then the shared activation logic.
    await this.findReceiverOrThrow(local.id, id);
    return this.enableById(id, tosId);
  }

  /**
   * Activate a receiver BY LOCAL ID across any consumer — the platform-admin (owner)
   * variant of {@link enable}. Skips consumer scoping; the AdminGuard authorizes it.
   * When `audit` is provided, the placeholder→real id write and the audit row commit together.
   */
  async enableById(id: string, tosId: string, audit?: AdminAuditData) {
    const row = await this.prisma.blindpayReceiver.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('Receiver not found');

    if (!row.blindpayId.startsWith(LOCAL_PREFIX)) {
      // Already created at BlindPay — nothing to do but return the current state.
      const refreshed = await this.refreshReceiver(row);
      if (audit) {
        await this.prisma.$transaction(async (tx) => {
          await recordAuditInTransaction(tx, audit);
        });
      }
      return refreshed;
    }
    // The customer can only accept terms after our owner/admin review approved it.
    if (row.kycStatus !== 'pending_user') {
      throw new BadRequestException(
        'Receiver must be approved (terms sent) before it can be activated.',
      );
    }

    const payload = (row.raw ?? {}) as Record<string, unknown>;
    const created = await this.blindpay.post<BlindpayObject>(
      this.blindpay.instancePath('/customers'),
      { ...payload, tos_id: tosId },
    );

    // Point the placeholder row at the real id + audit in one transaction, then mirror.
    await this.prisma.$transaction(async (tx) => {
      await tx.blindpayReceiver.update({
        where: { id: row.id },
        data: { blindpayId: asString(created.id) },
      });
      if (audit) {
        await recordAuditInTransaction(tx, audit);
      }
    });
    return this.sync.mirrorReceiver(row.consumerId, created);
  }

  /** Refresh a receiver row from BlindPay (mirror), falling back to the local row. */
  private async refreshReceiver(row: BlindpayReceiver) {
    if (row.blindpayId.startsWith(LOCAL_PREFIX)) return row;
    try {
      const fresh = await this.blindpay.get<BlindpayObject>(
        this.blindpay.instancePath(`/customers/${row.blindpayId}`),
      );
      return await this.sync.mirrorReceiver(row.consumerId, fresh);
    } catch {
      return row;
    }
  }

  async findAll(consumer: GatewayConsumer) {
    const local = await this.consumers.resolve(consumer);
    const data = await this.prisma.blindpayReceiver.findMany({
      where: { consumerId: local.id },
      orderBy: { createdAt: 'desc' },
    });
    return { data, total: data.length };
  }

  /**
   * Reads a receiver, refreshing it from BlindPay so the caller sees the latest
   * KYC status. Falls back to the local mirror if the provider call fails.
   */
  async findOne(consumer: GatewayConsumer, id: string) {
    const local = await this.consumers.resolve(consumer);
    const row = await this.findReceiverOrThrow(local.id, id);
    // An inactive (local-only) receiver has no BlindPay record to refresh from yet.
    if (row.blindpayId.startsWith(LOCAL_PREFIX)) {
      return row;
    }
    try {
      const fresh = await this.blindpay.get<BlindpayObject>(
        this.blindpay.instancePath(`/customers/${row.blindpayId}`),
      );
      return await this.sync.mirrorReceiver(local.id, fresh);
    } catch {
      return row;
    }
  }

  async update(consumer: GatewayConsumer, id: string, dto: UpdateReceiverDto) {
    const local = await this.consumers.resolve(consumer);
    const row = await this.findReceiverOrThrow(local.id, id);
    // The accepted terms-of-service id is set once, at enable() time, and can NEVER be
    // changed afterwards — otherwise a validated receiver's ToS acceptance could be
    // forged. Strip it from any update so it's immutable post-validation.
    const patch: Record<string, unknown> = { ...dto };
    delete patch.tos_id;
    const updated = await this.blindpay.put<BlindpayObject>(
      this.blindpay.instancePath(`/customers/${row.blindpayId}`),
      patch,
    );
    // BlindPay PUT may return little; ensure we keep the id.
    return this.sync.mirrorReceiver(local.id, {
      id: row.blindpayId,
      ...updated,
    });
  }

  async remove(consumer: GatewayConsumer, id: string) {
    const local = await this.consumers.resolve(consumer);
    const row = await this.findReceiverOrThrow(local.id, id);
    // Only delete at BlindPay if it was ever created there (inactive receivers are local-only).
    if (!row.blindpayId.startsWith(LOCAL_PREFIX)) {
      await this.blindpay.delete(
        this.blindpay.instancePath(`/customers/${row.blindpayId}`),
      );
    }
    await this.prisma.blindpayReceiver.delete({ where: { id: row.id } });
    return { id, deleted: true };
  }

  /**
   * Owner/admin kill-switch: enable or disable this fiat account. A disabled receiver
   * can't be used for onramp/offramp (see {@link assertEnabled}); re-enabling restores
   * it. The owner/admin gate is enforced upstream by the dev platform (only the dashboard
   * sets it, and only for org owners/admins). Independent of the BlindPay KYC status.
   */
  async setAccess(consumer: GatewayConsumer, id: string, disabled: boolean) {
    const local = await this.consumers.resolve(consumer);
    const row = await this.findReceiverOrThrow(local.id, id);
    return this.prisma.blindpayReceiver.update({
      where: { id: row.id },
      data: { disabled },
    });
  }

  /** Throws 403 when a receiver has been disabled — call before any fiat operation. */
  assertEnabled(receiver: { disabled: boolean }): void {
    if (receiver.disabled) {
      throw new ForbiddenException(
        'This fiat account is disabled. Re-enable it to use onramp/offramp.',
      );
    }
  }

  /**
   * Resolves a local receiver row for the consumer, or throws 404. Shared with
   * the wallet / bank-account / virtual-account services so a receiver id always
   * means "owned by this consumer".
   */
  async findReceiverOrThrow(
    consumerLocalId: string,
    id: string,
  ): Promise<BlindpayReceiver> {
    const row = await this.prisma.blindpayReceiver.findFirst({
      where: { id, consumerId: consumerLocalId },
    });
    if (!row) {
      throw new NotFoundException('Receiver not found');
    }
    return row;
  }
}

/**
 * Resolve the ToS email-resend cooldown (ms) from the dev platform's trusted headers.
 * The override is honored ONLY for internal (dashboard) calls: `X-Cosmos-Internal` is on
 * APISIX's header-remove list, so an external API-key caller can never set it and thus can
 * never shorten its own resend limit — it always falls back to the service default (24h).
 * `X-Cosmos-Tos-Cooldown-Ms` is the dev platform's role-derived value (owner → 0, admin →
 * 60000). Returns undefined for external callers or a missing/invalid value.
 */
export function resolveTosCooldownMs(
  internalHeader?: string | string[],
  cooldownHeader?: string | string[],
): number | undefined {
  const internal =
    (Array.isArray(internalHeader) ? internalHeader[0] : internalHeader) ===
    '1';
  if (!internal) return undefined;
  const raw = Array.isArray(cooldownHeader)
    ? cooldownHeader[0]
    : cooldownHeader;
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Display name for a receiver from its create payload (business legal name or person). */
function receiverName(dto: CreateReceiverDto): string | null {
  if (dto.legal_name) return dto.legal_name;
  const full = [dto.first_name, dto.last_name].filter(Boolean).join(' ').trim();
  return full || null;
}

/**
 * True when a create payload carries actual KYC/KYB data (beyond the bare registration
 * basics) — used to decide whether the new receiver starts in `pending_review` (data
 * uploaded, awaiting our review) or `inactive` (registration request only).
 */
function hasKycData(dto: CreateReceiverDto): boolean {
  return Boolean(
    dto.tax_id ||
    dto.date_of_birth ||
    dto.id_doc_front_file ||
    dto.selfie_file ||
    dto.legal_name ||
    dto.formation_date ||
    (dto.owners && dto.owners.length > 0),
  );
}
