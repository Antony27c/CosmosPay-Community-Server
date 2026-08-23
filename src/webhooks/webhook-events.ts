import { WebhookEventType } from '../../generated/prisma/client';

/**
 * Internal event name used with EventEmitter2. The webhook dispatcher listens
 * with the `webhook.*` wildcard so any domain module can fire notifications
 * without depending on the webhooks module directly.
 */
export const WEBHOOK_EVENT = 'webhook.event';

/**
 * Payload emitted on the internal bus. `consumerUsername` scopes delivery to the
 * integrator (APISIX consumer) that owns the affected resource.
 *
 * Integrator-facing webhook bodies stay `{ id, type, createdAt, data }` — this
 * class is the internal envelope, not the HTTP JSON.
 */
export class WebhookEventPayload {
  constructor(
    readonly consumerUsername: string,
    readonly type: WebhookEventType,
    readonly data: unknown,
  ) {}
}

/**
 * Terminal settlement events. Observer and submit can both reach these; emission
 * is gated on a unique `(eventType, resourceId, settlementEpoch)` claim so the
 * pair produces one notification, not two with different `evt_` ids. Epoch
 * advances on a FAILED → SUBMITTED resubmit so a later failure is a new event.
 */
export const TERMINAL_WEBHOOK_EVENTS = [
  'SWAP_SUCCEEDED',
  'SWAP_FAILED',
  'LIQUIDITY_SUCCEEDED',
  'LIQUIDITY_FAILED',
] as const satisfies readonly WebhookEventType[];

export type TerminalWebhookEventType = (typeof TERMINAL_WEBHOOK_EVENTS)[number];

export function isTerminalWebhookEvent(
  type: WebhookEventType,
): type is TerminalWebhookEventType {
  return (TERMINAL_WEBHOOK_EVENTS as readonly WebhookEventType[]).includes(
    type,
  );
}

/** Stable uniqueness key: one row per operation, event type, and attempt. */
export function terminalEventDedupKey(
  type: WebhookEventType,
  resourceId: string,
  settlementEpoch = 0,
): string {
  return `${type}:${resourceId}:${settlementEpoch}`;
}
