import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { WebhookEventType } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  WEBHOOK_EVENT,
  WebhookEventPayload,
  isTerminalWebhookEvent,
  terminalEventDedupKey,
} from './webhook-events';

/**
 * Single emission point for domain webhook events.
 *
 * Non-terminal events (CREATED / SUBMITTED / …) go straight to the bus.
 * Terminal settlement events first insert `webhook_emitted_event` under the
 * unique `dedupKey`. Winning that insert is what authorizes the bus emit;
 * a unique-constraint violation means another path already notified.
 */
@Injectable()
export class WebhookTerminalEmitter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * @returns `true` when this call owned the notification (or the event is
   * not terminal). `false` when a concurrent/prior claim already emitted.
   */
  async emit(
    consumerUsername: string,
    type: WebhookEventType,
    data: unknown,
  ): Promise<boolean> {
    if (isTerminalWebhookEvent(type)) {
      const resourceId = resourceIdOf(data);
      if (!resourceId) {
        throw new Error(
          `Terminal webhook event ${type} requires data.id to build the dedup key`,
        );
      }
      const claimed = await this.claim(
        type,
        resourceId,
        settlementEpochOf(data),
      );
      if (!claimed) return false;
    }

    this.events.emit(
      WEBHOOK_EVENT,
      new WebhookEventPayload(consumerUsername, type, data),
    );
    return true;
  }

  /**
   * Inserts the unique claim row. Relies on the database unique index — a
   * pre-check would race under concurrent observer + submit.
   */
  async claim(
    type: WebhookEventType,
    resourceId: string,
    settlementEpoch = 0,
  ): Promise<boolean> {
    try {
      await this.prisma.webhookEmittedEvent.create({
        data: {
          dedupKey: terminalEventDedupKey(type, resourceId, settlementEpoch),
          eventType: type,
        },
      });
      return true;
    } catch (err) {
      if (isUniqueConstraint(err)) return false;
      throw err;
    }
  }
}

function resourceIdOf(data: unknown): string | undefined {
  if (
    data !== null &&
    typeof data === 'object' &&
    'id' in data &&
    typeof (data as { id: unknown }).id === 'string'
  ) {
    return (data as { id: string }).id;
  }
  return undefined;
}

function settlementEpochOf(data: unknown): number {
  if (
    data !== null &&
    typeof data === 'object' &&
    'settlementEpoch' in data &&
    typeof (data as { settlementEpoch: unknown }).settlementEpoch === 'number'
  ) {
    return (data as { settlementEpoch: number }).settlementEpoch;
  }
  return 0;
}

/** True for a Prisma unique-constraint violation (P2002). */
function isUniqueConstraint(err: unknown): boolean {
  return (err as { code?: string })?.code === 'P2002';
}
