import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  WEBHOOK_EVENT,
  WebhookEventPayload,
  terminalEventDedupKey,
} from './webhook-events';
import { WebhookTerminalEmitter } from './webhook-terminal-emitter.service';

/**
 * In-memory stand-in for Postgres' unique index on `dedupKey`. Inserts on the
 * same key are serialized; the second throws P2002 — the same error Prisma
 * surfaces for a unique-constraint violation.
 */
function uniqueEmittedEventStore() {
  const rows = new Map<
    string,
    { id: string; dedupKey: string; eventType: string; createdAt: Date }
  >();
  const tails = new Map<string, Promise<unknown>>();
  let seq = 0;

  const create = async ({
    data,
  }: {
    data: { dedupKey: string; eventType: string };
  }) => {
    const prev = tails.get(data.dedupKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    tails.set(
      data.dedupKey,
      prev.then(
        () => gate,
        () => gate,
      ),
    );
    try {
      await prev.catch(() => undefined);
      if (rows.has(data.dedupKey)) {
        const err: Error & { code?: string; meta?: { target: string[] } } =
          Object.assign(
            new Error('Unique constraint failed on the fields: (`dedupKey`)'),
            {
              code: 'P2002',
              meta: { target: ['dedupKey'] },
            },
          );
        throw err;
      }
      const row = { id: `wee_${++seq}`, createdAt: new Date(), ...data };
      rows.set(data.dedupKey, row);
      return row;
    } finally {
      release();
    }
  };

  return {
    rows,
    create: jest.fn(create),
  };
}

function build() {
  const store = uniqueEmittedEventStore();
  const prisma = { webhookEmittedEvent: store } as any;
  const events = { emit: jest.fn() } as unknown as EventEmitter2;
  const emitter = new WebhookTerminalEmitter(prisma, events);
  return { emitter, prisma, events, store };
}

function terminalCalls(events: EventEmitter2, type: string) {
  return (events.emit as unknown as jest.Mock).mock.calls.filter(
    ([name, payload]) => name === WEBHOOK_EVENT && payload.type === type,
  );
}

describe('WebhookTerminalEmitter (issue #29)', () => {
  it('schema and migration declare a unique index on webhook_emitted_event.dedupKey', () => {
    const schema = readFileSync(
      join(__dirname, '../../prisma/schema.prisma'),
      'utf8',
    );
    expect(schema).toMatch(
      /model WebhookEmittedEvent[\s\S]*dedupKey\s+String\s+@unique/,
    );

    const sql = readFileSync(
      join(
        __dirname,
        '../../prisma/migrations/20260823040000_webhook_emitted_event/migration.sql',
      ),
      'utf8',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "webhook_emitted_event_dedupKey_key" ON "webhook_emitted_event"("dedupKey")',
    );
  });

  it('builds a stable dedup key per operation and terminal event type', () => {
    expect(terminalEventDedupKey('SWAP_SUCCEEDED', 'swap_1')).toBe(
      'SWAP_SUCCEEDED:swap_1',
    );
    expect(terminalEventDedupKey('SWAP_FAILED', 'swap_1')).toBe(
      'SWAP_FAILED:swap_1',
    );
    expect(terminalEventDedupKey('LIQUIDITY_SUCCEEDED', 'op_1')).toBe(
      'LIQUIDITY_SUCCEEDED:op_1',
    );
  });

  it('emits SWAP_SUCCEEDED once; a second insert of the same key fails with P2002', async () => {
    const { emitter, events, prisma } = build();
    const data = { id: 'swap_1', status: 'SUCCEEDED' };

    const first = await emitter.emit('cosmos_u1', 'SWAP_SUCCEEDED', data);
    expect(first).toBe(true);
    expect(terminalCalls(events, 'SWAP_SUCCEEDED')).toHaveLength(1);

    // The case that used to pass a duplicate through: a second emit attempt
    // for the same (operation, event type). The unique index rejects it.
    await expect(
      prisma.webhookEmittedEvent.create({
        data: {
          dedupKey: terminalEventDedupKey('SWAP_SUCCEEDED', 'swap_1'),
          eventType: 'SWAP_SUCCEEDED',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002', meta: { target: ['dedupKey'] } });

    const second = await emitter.emit('cosmos_u1', 'SWAP_SUCCEEDED', data);
    expect(second).toBe(false);
    expect(terminalCalls(events, 'SWAP_SUCCEEDED')).toHaveLength(1);
  });

  it('concurrent observer-and-submit style emits produce a single bus event', async () => {
    const { emitter, events } = build();
    const data = { id: 'swap_race', status: 'SUCCEEDED' };

    // This is the case that used to fail: two paths arriving at the same
    // terminal transition each minted their own evt_ id. Now only the winner
    // of the unique insert emits.
    const results = await Promise.all(
      Array.from({ length: 32 }, () =>
        emitter.emit('cosmos_u1', 'SWAP_SUCCEEDED', data),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((won) => !won)).toHaveLength(31);
    expect(terminalCalls(events, 'SWAP_SUCCEEDED')).toHaveLength(1);

    const [, payload] = (events.emit as unknown as jest.Mock).mock.calls[0];
    expect(payload).toBeInstanceOf(WebhookEventPayload);
    expect(payload.consumerUsername).toBe('cosmos_u1');
    expect(payload.type).toBe('SWAP_SUCCEEDED');
    expect(payload.data).toEqual(data);
    // Integrator-facing envelope is still built by the dispatcher from this
    // payload; we do not add fields that would change HTTP JSON shape.
    expect(Object.keys(payload)).toEqual(['consumerUsername', 'type', 'data']);
  });

  it('does not claim a unique row for non-terminal events', async () => {
    const { emitter, events, prisma } = build();
    const created = await emitter.emit('cosmos_u1', 'SWAP_CREATED', {
      id: 'swap_1',
    });
    expect(created).toBe(true);
    expect(prisma.webhookEmittedEvent.create).not.toHaveBeenCalled();
    expect(terminalCalls(events, 'SWAP_CREATED')).toHaveLength(1);
  });

  it('allows SUCCEEDED and FAILED claims on the same operation (different keys)', async () => {
    const { emitter, events } = build();
    await expect(
      emitter.emit('cosmos_u1', 'SWAP_SUCCEEDED', { id: 'swap_1' }),
    ).resolves.toBe(true);
    await expect(
      emitter.emit('cosmos_u1', 'SWAP_FAILED', { id: 'swap_1' }),
    ).resolves.toBe(true);
    expect(terminalCalls(events, 'SWAP_SUCCEEDED')).toHaveLength(1);
    expect(terminalCalls(events, 'SWAP_FAILED')).toHaveLength(1);
  });
});
