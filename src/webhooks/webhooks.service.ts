import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfig } from '../config/configuration';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import type {
  WebhookDelivery,
  WebhookEndpoint,
} from '../../generated/prisma/client';
import { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';
import { UpdateWebhookEndpointDto } from './dto/update-webhook-endpoint.dto';
import { QueryDeliveriesDto } from './dto/query-deliveries.dto';
import { RotateWebhookSecretDto } from './dto/rotate-webhook-secret.dto';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookDestinationGuard } from './webhook-destination.guard';
import { WebhookUrlValidationError } from './webhook-url.validator';

// Endpoint without signing secrets — what list/get responses return.
export type SafeWebhookEndpoint = Omit<
  WebhookEndpoint,
  'secret' | 'previousSecret'
>;

/** Create / rotate responses: current secret only, never the previous one. */
export type WebhookEndpointWithSecret = Omit<WebhookEndpoint, 'previousSecret'>;

function omitFields<T extends object, K extends keyof T>(
  obj: T,
  ...keys: K[]
): Omit<T, K> {
  const clone = { ...obj };
  for (const key of keys) {
    delete clone[key];
  }
  return clone;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: WebhookDispatcherService,
    private readonly destinations: WebhookDestinationGuard,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private resolveConsumer(consumer: GatewayConsumer) {
    return this.prisma.consumer.upsert({
      where: { apisixUsername: consumer.username },
      create: {
        apisixUsername: consumer.username,
        credentialId: consumer.credentialId,
      },
      update: { credentialId: consumer.credentialId },
    });
  }

  private generateSecret(): string {
    return `whsec_${randomBytes(24).toString('hex')}`;
  }

  private strip(endpoint: WebhookEndpoint): SafeWebhookEndpoint {
    return omitFields(endpoint, 'secret', 'previousSecret');
  }

  private stripPrevious(endpoint: WebhookEndpoint): WebhookEndpointWithSecret {
    return omitFields(endpoint, 'previousSecret');
  }

  // ── CRUD: endpoints ─────────────────────────────────────────────────────────
  /** Returns the full endpoint INCLUDING the secret — shown only once, here. */
  async create(
    consumer: GatewayConsumer,
    dto: CreateWebhookEndpointDto,
  ): Promise<WebhookEndpointWithSecret> {
    await this.assertUrlAllowed(dto.url);
    const localConsumer = await this.resolveConsumer(consumer);

    const endpoint = await this.prisma.webhookEndpoint.create({
      data: {
        consumerId: localConsumer.id,
        url: dto.url,
        secret: this.generateSecret(),
        description: dto.description,
        eventTypes: dto.eventTypes ?? [],
        destinationBlocked: false,
      },
    });

    this.logger.log(
      `Registered webhook endpoint ${endpoint.id} (${endpoint.url}) for ${consumer.username}`,
    );
    return this.stripPrevious(endpoint);
  }

  async findAll(consumer: GatewayConsumer): Promise<SafeWebhookEndpoint[]> {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { consumer: { apisixUsername: consumer.username } },
      orderBy: { createdAt: 'desc' },
    });
    return endpoints.map((e) => this.strip(e));
  }

  async findOne(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<SafeWebhookEndpoint> {
    return this.strip(await this.getOwned(consumer, id));
  }

  async update(
    consumer: GatewayConsumer,
    id: string,
    dto: UpdateWebhookEndpointDto,
  ): Promise<SafeWebhookEndpoint> {
    const current = await this.getOwned(consumer, id);
    if (dto.url !== undefined) {
      await this.assertUrlAllowed(dto.url);
    } else if (dto.enabled === true) {
      // Re-enable only when the stored URL still resolves to a public target.
      await this.assertUrlAllowed(current.url);
    }

    const clearBlock = dto.url !== undefined || dto.enabled === true;
    const updated = await this.prisma.webhookEndpoint.update({
      where: { id },
      data: {
        ...(dto.url !== undefined ? { url: dto.url } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.eventTypes !== undefined ? { eventTypes: dto.eventTypes } : {}),
        ...(clearBlock ? { destinationBlocked: false } : {}),
      },
    });
    this.logger.log(`Updated webhook endpoint ${id} for ${consumer.username}`);
    return this.strip(updated);
  }

  async remove(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    await this.getOwned(consumer, id);
    await this.prisma.webhookEndpoint.delete({ where: { id } });
    this.logger.log(`Deleted webhook endpoint ${id} for ${consumer.username}`);
    return { id, deleted: true };
  }

  /**
   * Rotates the signing secret. Returns the endpoint WITH the new secret
   * (never the previous one). The old secret keeps signing deliveries until
   * `previousSecretExpiresAt`, unless `graceSeconds=0` revokes it immediately.
   *
   * A second rotate while the grace window is still open keeps the original
   * previous secret and its expiry. Overwriting it would drop the secret
   * production handlers may still be verifying.
   */
  async rotateSecret(
    consumer: GatewayConsumer,
    id: string,
    dto: RotateWebhookSecretDto = {},
  ): Promise<WebhookEndpointWithSecret> {
    const current = await this.getOwned(consumer, id);
    const maxGrace = this.config.get('webhooks', {
      infer: true,
    }).secretGraceSeconds;
    const graceSeconds = dto.graceSeconds ?? maxGrace;
    if (graceSeconds > maxGrace) {
      throw new BadRequestException(
        `graceSeconds cannot exceed the configured maximum (${maxGrace})`,
      );
    }

    const newSecret = this.generateSecret();
    const revokeImmediately = graceSeconds === 0;
    const keepOriginalPrevious =
      !revokeImmediately &&
      current.previousSecret != null &&
      current.previousSecretExpiresAt != null &&
      current.previousSecretExpiresAt.getTime() > Date.now();
    const updated = await this.prisma.webhookEndpoint.update({
      where: { id },
      data: {
        secret: newSecret,
        previousSecret: revokeImmediately
          ? null
          : keepOriginalPrevious
            ? current.previousSecret
            : current.secret,
        previousSecretExpiresAt: revokeImmediately
          ? null
          : keepOriginalPrevious
            ? current.previousSecretExpiresAt
            : new Date(Date.now() + graceSeconds * 1000),
      },
    });
    this.logger.log(
      `Rotated secret for webhook endpoint ${id} (graceSeconds=${graceSeconds})`,
    );
    return this.stripPrevious(updated);
  }

  // ── Deliveries (traceability) ────────────────────────────────────────────────
  async listDeliveries(
    consumer: GatewayConsumer,
    id: string,
    query: QueryDeliveriesDto,
  ): Promise<{
    data: WebhookDelivery[];
    total: number;
    take: number;
    skip: number;
  }> {
    await this.getOwned(consumer, id);
    const where = {
      endpointId: id,
      ...(query.status ? { status: query.status } : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.webhookDelivery.findMany({
        where,
        take: query.take,
        skip: query.skip,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.webhookDelivery.count({ where }),
    ]);
    return { data, total, take: query.take, skip: query.skip };
  }

  /** Manually re-sends a past delivery (e.g. after the integrator was down). */
  async redeliver(
    consumer: GatewayConsumer,
    endpointId: string,
    deliveryId: string,
  ): Promise<WebhookDelivery> {
    await this.getOwned(consumer, endpointId);
    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, endpointId },
    });
    if (!delivery) {
      throw new NotFoundException(`Delivery ${deliveryId} not found`);
    }
    return this.dispatcher.redeliver(delivery);
  }

  /** Sends a test event so integrators can verify their endpoint + signature. */
  async ping(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<{
    ok: boolean;
    responseStatus: number | null;
    error: string | null;
  }> {
    const endpoint = await this.getOwned(consumer, id);
    return this.dispatcher.pingEndpoint(endpoint);
  }

  /** Loads an endpoint or throws 404 unless it belongs to the consumer. */
  private async getOwned(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<WebhookEndpoint> {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id, consumer: { apisixUsername: consumer.username } },
    });
    if (!endpoint) {
      throw new NotFoundException(`Webhook endpoint ${id} not found`);
    }
    return endpoint;
  }

  private async assertUrlAllowed(url: string): Promise<void> {
    try {
      await this.destinations.assertSafe(url);
    } catch (err) {
      if (err instanceof WebhookUrlValidationError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }
}
