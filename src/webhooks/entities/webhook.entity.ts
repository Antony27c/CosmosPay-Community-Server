import { ApiProperty } from '@nestjs/swagger';
import {
  WebhookDeliveryStatus,
  WebhookEventType,
} from '../../../generated/prisma/client';

/** Endpoint without the secret — list/get responses. */
export class WebhookEndpointEntity {
  @ApiProperty({ example: 'we_9z8a1b0000abcd1234efgh' })
  id!: string;

  @ApiProperty({ example: 'https://integrator.example.com/webhooks/cosmos' })
  url!: string;

  @ApiProperty({ nullable: true, example: 'Production payment events' })
  description!: string | null;

  @ApiProperty({ example: true })
  enabled!: boolean;

  @ApiProperty({
    example: false,
    description:
      'True when the URL failed public-destination checks (SSRF policy). Deliveries are skipped until the URL is updated to a safe https endpoint.',
  })
  destinationBlocked!: boolean;

  @ApiProperty({
    enum: WebhookEventType,
    isArray: true,
    example: ['PAYMENT_INTENT_SUCCEEDED'],
    description: 'Subscribed events; empty means all.',
  })
  eventTypes!: WebhookEventType[];

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    example: '2026-08-26T17:00:00.000Z',
    description:
      'When the previous signing secret stops being accepted on deliveries. Null when no rotation is in flight. The previous secret value itself is never returned.',
  })
  previousSecretExpiresAt!: Date | null;

  @ApiProperty({ example: '2026-06-21T12:34:56.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-06-21T12:34:56.000Z' })
  updatedAt!: Date;
}

/** Endpoint WITH the signing secret — returned only on create / rotate. */
export class WebhookEndpointWithSecretEntity extends WebhookEndpointEntity {
  @ApiProperty({
    description: 'HMAC signing secret — shown once. Store it securely.',
    example: 'whsec_3f9a1c…',
  })
  secret!: string;
}

export class WebhookDeliveryEntity {
  @ApiProperty({ example: 'wd_9z8a1b0000abcd1234efgh' })
  id!: string;

  @ApiProperty({ example: 'we_9z8a1b0000abcd1234efgh' })
  endpointId!: string;

  @ApiProperty({ enum: WebhookEventType, example: 'PAYMENT_INTENT_SUCCEEDED' })
  eventType!: WebhookEventType;

  @ApiProperty({ example: 'evt_2c3d4e5f-aaaa-bbbb-cccc-1234567890ab' })
  eventId!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: {
      id: 'evt_2c3d…',
      type: 'PAYMENT_INTENT_SUCCEEDED',
      createdAt: '2026-06-21T12:34:56.000Z',
      data: { id: 'clx9z8a1b…', status: 'SUCCEEDED' },
    },
  })
  payload!: unknown;

  @ApiProperty({ enum: WebhookDeliveryStatus, example: 'SUCCEEDED' })
  status!: WebhookDeliveryStatus;

  @ApiProperty({ example: 1 })
  attempts!: number;

  @ApiProperty({
    example: 8,
    description: 'Retry budget snapshotted at enqueue.',
  })
  maxAttempts!: number;

  @ApiProperty({ nullable: true, example: 200 })
  responseStatus!: number | null;

  @ApiProperty({ nullable: true, example: null })
  error!: string | null;

  @ApiProperty({ nullable: true, example: '2026-06-21T12:34:57.000Z' })
  lastAttemptAt!: Date | null;

  @ApiProperty({
    nullable: true,
    example: '2026-06-21T12:35:01.000Z',
    description: 'When the retry worker may attempt this delivery next.',
  })
  nextAttemptAt!: Date | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description: 'Exclusive claim held by a worker replica until this instant.',
  })
  leaseUntil!: Date | null;

  @ApiProperty({ example: '2026-06-21T12:34:56.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-06-21T12:34:57.000Z' })
  updatedAt!: Date;
}

export class WebhookDeliveryListEntity {
  @ApiProperty({ type: [WebhookDeliveryEntity] })
  data!: WebhookDeliveryEntity[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiProperty({ example: 20 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}

export class WebhookPingEntity {
  @ApiProperty({ example: true })
  ok!: boolean;

  @ApiProperty({ nullable: true, example: 200 })
  responseStatus!: number | null;

  @ApiProperty({ nullable: true, example: null })
  error!: string | null;
}

export class WebhookDeletedEntity {
  @ApiProperty({ example: 'we_9z8a1b0000abcd1234efgh' })
  id!: string;

  @ApiProperty({ example: true })
  deleted!: boolean;
}
