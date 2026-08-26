import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import type {
  Prisma,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEventType,
} from '../../generated/prisma/client';
import { WEBHOOK_EVENT, WebhookEventPayload } from './webhook-events';
import { buildSignatureHeader, signingSecretsFor } from './webhook-signature';
import { WebhookDestinationGuard } from './webhook-destination.guard';
import { consumeResponseBody, webhookAbortSignal } from './webhook-http';
import { WebhookUrlValidationError } from './webhook-url.validator';
import { mapWithConcurrency } from './map-with-concurrency';

/** Result of a single signed POST to the integrator. Retry policy lives in the worker. */
export type WebhookAttemptResult =
  | { ok: true; responseStatus: number; error: null; fatal: false }
  | {
      ok: false;
      responseStatus: number | null;
      error: string;
      fatal: boolean;
    };

@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly destinations: WebhookDestinationGuard,
  ) {}

  /**
   * Fans out a domain event to every enabled endpoint of the owning consumer
   * that is subscribed to the event type (empty subscription list = all).
   * Enqueues a delivery row per target and returns — the retry worker owns
   * the HTTP attempt so a restart cannot strand a PENDING row.
   */
  @OnEvent(WEBHOOK_EVENT, { async: true, promisify: true })
  async handleEvent(payload: WebhookEventPayload): Promise<void> {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: {
        enabled: true,
        destinationBlocked: false,
        consumer: { apisixUsername: payload.consumerUsername },
      },
    });

    const targets = endpoints.filter(
      (e) => e.eventTypes.length === 0 || e.eventTypes.includes(payload.type),
    );

    if (targets.length === 0) {
      return;
    }

    const eventId = `evt_${randomUUID()}`;
    this.logger.log(
      `Dispatching ${payload.type} (${eventId}) to ${targets.length} endpoint(s) for ${payload.consumerUsername}`,
    );

    const { fanoutConcurrency } = this.config.get('webhooks', { infer: true });
    try {
      await mapWithConcurrency(targets, fanoutConcurrency, async (endpoint) => {
        try {
          await this.enqueue(endpoint, payload.type, eventId, payload.data);
        } catch (err) {
          this.logger.error(
            `Failed to enqueue ${payload.type} for endpoint ${endpoint.id}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        }
      });
    } catch (err) {
      this.logger.error(
        `Webhook fan-out failed for ${payload.type} (${eventId})`,
        err as Error,
      );
    }
  }

  /** Persists a PENDING delivery for the retry worker. Does not call the integrator. */
  private async enqueue(
    endpoint: WebhookEndpoint,
    eventType: WebhookEventType,
    eventId: string,
    data: unknown,
  ): Promise<WebhookDelivery> {
    const { maxAttempts } = this.config.get('webhooks', { infer: true });
    const body = this.buildBody(eventId, eventType, data);

    return this.prisma.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        eventType,
        eventId,
        payload: body as Prisma.InputJsonValue,
        status: 'PENDING',
        nextAttemptAt: new Date(),
        maxAttempts,
      },
    });
  }

  /**
   * Re-queues an existing delivery for the worker (manual redelivery).
   * Returns the updated record without waiting on the integrator.
   */
  async redeliver(delivery: WebhookDelivery): Promise<WebhookDelivery> {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({
      where: { id: delivery.endpointId },
    });
    if (!endpoint) {
      throw new Error(`Endpoint ${delivery.endpointId} no longer exists`);
    }
    const { maxAttempts } = this.config.get('webhooks', { infer: true });
    return this.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'PENDING',
        nextAttemptAt: new Date(),
        leaseUntil: null,
        error: null,
        attempts: 0,
        maxAttempts,
      },
    });
  }

  /**
   * One signed POST. Does not persist status — the worker decides retry vs fail.
   * `fatal` means do not retry (SSRF / destination blocked).
   */
  async attemptOnce(
    endpoint: WebhookEndpoint,
    delivery: WebhookDelivery,
  ): Promise<WebhookAttemptResult> {
    const {
      connectTimeoutMs,
      readTimeoutMs,
      maxResponseBytes,
      signatureHeader,
    } = this.config.get('webhooks', { infer: true });

    const body = JSON.stringify(delivery.payload);

    try {
      await this.destinations.assertSafe(endpoint.url);
    } catch (err) {
      const error =
        err instanceof WebhookUrlValidationError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Destination validation failed';
      await this.markDestinationBlocked(endpoint.id, error);
      return { ok: false, responseStatus: null, error, fatal: true };
    }

    const signal = webhookAbortSignal({
      connectTimeoutMs,
      readTimeoutMs,
    });

    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        // Never follow 3xx — webhook receivers must be the registered URL.
        redirect: 'manual',
        signal,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'CosmosPay-Webhooks/1.0',
          [signatureHeader]: buildSignatureHeader(
            signingSecretsFor(endpoint),
            body,
            Math.floor(Date.now() / 1000),
          ),
          'x-cosmos-event': delivery.eventType,
          'x-cosmos-event-id': delivery.eventId,
          'x-cosmos-delivery': delivery.id,
        },
        body,
      });

      await consumeResponseBody(res, maxResponseBytes);

      if (res.ok) {
        return {
          ok: true,
          responseStatus: res.status,
          error: null,
          fatal: false,
        };
      }
      return {
        ok: false,
        responseStatus: res.status,
        error: `Non-2xx response: ${res.status}`,
        fatal: false,
      };
    } catch (err) {
      return {
        ok: false,
        responseStatus: null,
        error: err instanceof Error ? err.message : 'Unknown delivery error',
        fatal: false,
      };
    }
  }

  /**
   * One-off signed test POST to an endpoint. Not persisted as a delivery — it
   * just lets an integrator confirm reachability and signature verification.
   */
  async pingEndpoint(endpoint: WebhookEndpoint): Promise<{
    ok: boolean;
    responseStatus: number | null;
    error: string | null;
  }> {
    const {
      connectTimeoutMs,
      readTimeoutMs,
      maxResponseBytes,
      signatureHeader,
    } = this.config.get('webhooks', {
      infer: true,
    });

    try {
      await this.destinations.assertSafe(endpoint.url);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Destination validation failed';
      await this.markDestinationBlocked(endpoint.id, message);
      return { ok: false, responseStatus: null, error: message };
    }

    const body = JSON.stringify({
      id: `evt_ping_${randomUUID()}`,
      type: 'ping',
      createdAt: new Date().toISOString(),
      data: { message: 'Cosmos Pay webhook ping' },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signal = webhookAbortSignal({
      connectTimeoutMs,
      readTimeoutMs,
    });

    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        redirect: 'manual',
        signal,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'CosmosPay-Webhooks/1.0',
          [signatureHeader]: buildSignatureHeader(
            signingSecretsFor(endpoint),
            body,
            timestamp,
          ),
          'x-cosmos-event': 'ping',
        },
        body,
      });
      await consumeResponseBody(res, maxResponseBytes);
      return { ok: res.ok, responseStatus: res.status, error: null };
    } catch (err) {
      return {
        ok: false,
        responseStatus: null,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  private async markDestinationBlocked(
    endpointId: string,
    reason: string,
  ): Promise<void> {
    this.logger.warn(
      `Marking webhook endpoint ${endpointId} as destinationBlocked: ${reason}`,
    );
    await this.prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: {
        destinationBlocked: true,
        enabled: false,
      },
    });
  }

  private buildBody(
    eventId: string,
    eventType: WebhookEventType,
    data: unknown,
  ): Record<string, unknown> {
    return {
      id: eventId,
      type: eventType,
      createdAt: new Date().toISOString(),
      data,
    };
  }
}
