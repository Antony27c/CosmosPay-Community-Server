import { Logger } from '@nestjs/common';
import { WebhookRetryWorkerService } from './webhook-retry-worker.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { computeWebhookBackoffMs } from './webhook-backoff';
import type {
  WebhookDelivery,
  WebhookEndpoint,
} from '../../generated/prisma/client';

describe('WebhookRetryWorkerService', () => {
  const endpoint: WebhookEndpoint = {
    id: 'we_1',
    consumerId: 'c1',
    url: 'https://integrator.example.com/hook',
    secret: 'whsec_test',
    previousSecret: null,
    previousSecretExpiresAt: null,
    description: null,
    enabled: true,
    destinationBlocked: false,
    eventTypes: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const webhookCfg = {
    maxAttempts: 8,
    backoffMs: 1000,
    maxBackoffMs: 8000,
    timeoutMs: 1000,
    connectTimeoutMs: 500,
    readTimeoutMs: 1000,
    maxResponseBytes: 1024,
    signatureHeader: 'x-cosmos-signature',
    fanoutConcurrency: 5,
    workerIntervalMs: 1000,
    workerBatchSize: 50,
    leaseMs: 30_000,
    pauseAfterFailures: 3,
  };

  function delivery(
    overrides?: Partial<WebhookDelivery>,
  ): WebhookDelivery & { endpoint: WebhookEndpoint } {
    return {
      id: 'wd_1',
      endpointId: endpoint.id,
      eventType: 'PAYMENT_INTENT_SUCCEEDED',
      eventId: 'evt_1',
      payload: {
        id: 'evt_1',
        type: 'PAYMENT_INTENT_SUCCEEDED',
        createdAt: '2026-01-01T00:00:00.000Z',
        data: { id: 'pi_1' },
      },
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 8,
      responseStatus: null,
      error: null,
      lastAttemptAt: null,
      nextAttemptAt: new Date(Date.now() - 1000),
      leaseUntil: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date(),
      endpoint,
      ...overrides,
    };
  }

  function build(opts?: {
    cfg?: Partial<typeof webhookCfg>;
    attemptOnce?: jest.Mock;
    rows?: Array<WebhookDelivery & { endpoint: WebhookEndpoint }>;
  }) {
    const cfg = { ...webhookCfg, ...opts?.cfg };
    const rows = opts?.rows ?? [];
    const store = new Map(rows.map((r) => [r.id, { ...r }]));

    const prisma = {
      webhookDelivery: {
        findMany: jest.fn(async ({ where, take }: any) => {
          const statuses: string[] | undefined = where?.status?.in;
          const listed = [...store.values()].filter((row) => {
            if (statuses && !statuses.includes(row.status)) return false;
            if (where?.endpointId && row.endpointId !== where.endpointId) {
              return false;
            }
            return true;
          });
          const sliced =
            typeof take === 'number' ? listed.slice(0, take) : listed;
          return sliced.map((row) => ({ ...row }));
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const row = store.get(where.id);
          if (!row) return { count: 0 };
          const allowed: string[] = where.status?.in ?? [];
          if (allowed.length && !allowed.includes(row.status)) {
            return { count: 0 };
          }
          if (row.leaseUntil && row.leaseUntil > new Date()) {
            return { count: 0 };
          }
          Object.assign(row, data);
          return { count: 1 };
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const row = store.get(where.id);
          if (!row) return { id: where.id, ...data };
          Object.assign(row, data);
          return { ...row };
        }),
      },
      webhookEndpoint: {
        update: jest.fn(async ({ where, data }: any) => {
          Object.assign(endpoint, data);
          return { ...endpoint, id: where.id, ...data };
        }),
      },
    };

    const attemptOnce =
      opts?.attemptOnce ??
      jest.fn().mockResolvedValue({
        ok: true,
        responseStatus: 200,
        error: null,
        fatal: false,
      });

    const dispatcher = { attemptOnce } as unknown as WebhookDispatcherService;
    const config = { get: () => cfg } as any;
    const worker = new WebhookRetryWorkerService(
      prisma as any,
      config,
      dispatcher,
    );
    return { worker, prisma, attemptOnce, store, cfg, dispatcher };
  }

  afterEach(() => {
    jest.restoreAllMocks();
    endpoint.enabled = true;
    endpoint.destinationBlocked = false;
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  it('starts an unrefed interval and clears it on destroy', () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const fakeTimer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
    const setIntervalSpy = jest
      .spyOn(global, 'setInterval')
      .mockReturnValue(fakeTimer);
    const clearSpy = jest
      .spyOn(global, 'clearInterval')
      .mockImplementation(() => undefined);

    const { worker } = build();
    worker.onModuleInit();

    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      webhookCfg.workerIntervalMs,
    );
    expect((fakeTimer as any).unref).toHaveBeenCalled();

    worker.onModuleDestroy();
    expect(clearSpy).toHaveBeenCalledWith(fakeTimer);
  });

  it('skips overlapping ticks (re-entry guard)', async () => {
    let release!: () => void;
    const { worker, prisma, attemptOnce } = build({
      rows: [delivery()],
    });
    prisma.webhookDelivery.findMany.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve([delivery()]);
        }),
    );

    const first = worker.tick();
    const second = worker.tick();
    release();
    await Promise.all([first, second]);

    expect(prisma.webhookDelivery.findMany).toHaveBeenCalledTimes(1);
    expect(attemptOnce).toHaveBeenCalledTimes(1);
  });

  it('delivery quedó PENDING de una corrida anterior, el worker la levanta y la entrega', async () => {
    const row = delivery({
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: new Date(Date.now() - 60_000),
      leaseUntil: null,
    });
    const attemptOnce = jest.fn().mockResolvedValue({
      ok: true,
      responseStatus: 200,
      error: null,
      fatal: false,
    });
    const { worker, store } = build({ rows: [row], attemptOnce });

    await worker.tick();

    expect(attemptOnce).toHaveBeenCalledTimes(1);
    expect(attemptOnce.mock.calls[0][0].id).toBe(endpoint.id);
    expect(attemptOnce.mock.calls[0][1].id).toBe('wd_1');
    const updated = store.get('wd_1')!;
    expect(updated.status).toBe('SUCCEEDED');
    expect(updated.attempts).toBe(1);
    expect(updated.nextAttemptAt).toBeNull();
    expect(updated.leaseUntil).toBeNull();
  });

  it('two worker replicas do not deliver the same row twice', async () => {
    const attemptOnce = jest.fn().mockResolvedValue({
      ok: true,
      responseStatus: 200,
      error: null,
      fatal: false,
    });
    const row = delivery();
    const a = build({ rows: [row], attemptOnce });
    // Share the same store/prisma so the conditional updateMany is the lock.
    const workerB = new WebhookRetryWorkerService(
      a.prisma as any,
      { get: () => webhookCfg } as any,
      { attemptOnce } as any,
    );

    await Promise.all([a.worker.tick(), workerB.tick()]);

    expect(attemptOnce).toHaveBeenCalledTimes(1);
    expect(a.prisma.webhookDelivery.updateMany).toHaveBeenCalled();
  });

  it('agotados los maxAttempts, la delivery queda FAILED y nextAttemptAt en null, y no vuelve a ser tomada por el siguiente tick', async () => {
    const attemptOnce = jest.fn().mockResolvedValue({
      ok: false,
      responseStatus: 500,
      error: 'Non-2xx response: 500',
      fatal: false,
    });
    const row = delivery({
      status: 'RETRYING',
      attempts: 2,
      maxAttempts: 3,
    });
    const { worker, store, prisma } = build({
      rows: [row],
      attemptOnce,
      cfg: { pauseAfterFailures: 99 },
    });

    await worker.tick();

    const after = store.get('wd_1')!;
    expect(after.status).toBe('FAILED');
    expect(after.nextAttemptAt).toBeNull();
    expect(after.attempts).toBe(3);
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          nextAttemptAt: null,
        }),
      }),
    );

    attemptOnce.mockClear();
    await worker.tick();
    expect(attemptOnce).not.toHaveBeenCalled();
  });

  it('tras N fallos el endpoint queda enabled=false', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const attemptOnce = jest.fn().mockResolvedValue({
      ok: false,
      responseStatus: 500,
      error: 'Non-2xx response: 500',
      fatal: false,
    });
    const rows = [1, 2, 3].map((n) =>
      delivery({
        id: `wd_${n}`,
        attempts: 0,
        maxAttempts: 1,
        createdAt: new Date(Date.now() - (4 - n) * 1000),
      }),
    );
    const { worker, prisma } = build({
      rows,
      attemptOnce,
      cfg: { pauseAfterFailures: 3, fanoutConcurrency: 1 },
    });

    await worker.tick();

    expect(endpoint.enabled).toBe(false);
    expect(prisma.webhookEndpoint.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: endpoint.id },
        data: { enabled: false },
      }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /Paused webhook endpoint we_1 .*integrator\.example\.com/,
      ),
    );
  });

  it('schedules RETRYING with nextAttemptAt when attempts remain', async () => {
    const attemptOnce = jest.fn().mockResolvedValue({
      ok: false,
      responseStatus: null,
      error: 'ECONNREFUSED',
      fatal: false,
    });
    const { worker, store } = build({
      rows: [delivery({ attempts: 0, maxAttempts: 8 })],
      attemptOnce,
    });

    await worker.tick();

    const after = store.get('wd_1')!;
    expect(after.status).toBe('RETRYING');
    expect(after.attempts).toBe(1);
    expect(after.nextAttemptAt).toBeInstanceOf(Date);
    expect(after.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(after.leaseUntil).toBeNull();
  });

  it('fan-out does not launch more than N fetch simultaneously (20 deliveries, cap 5)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const attemptOnce = jest.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return {
        ok: true,
        responseStatus: 200,
        error: null,
        fatal: false,
      };
    });
    const rows = Array.from({ length: 20 }, (_, i) =>
      delivery({
        id: `wd_${i}`,
        createdAt: new Date(Date.now() - (20 - i) * 1000),
      }),
    );
    const { worker } = build({
      rows,
      attemptOnce,
      cfg: { fanoutConcurrency: 5 },
    });

    await worker.tick();

    expect(attemptOnce).toHaveBeenCalledTimes(20);
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBe(5);
  });

  it('el cálculo de backoff es exponencial, respeta maxBackoffMs como techo y dos llamadas seguidas con el mismo attempts dan valores distintos (jitter)', () => {
    const noJitter = () => 1;
    expect(computeWebhookBackoffMs(1, 1000, 8000, noJitter)).toBe(2000);
    expect(computeWebhookBackoffMs(2, 1000, 8000, noJitter)).toBe(4000);
    expect(computeWebhookBackoffMs(4, 1000, 8000, noJitter)).toBe(8000);

    const random = jest.spyOn(Math, 'random');
    random.mockReturnValueOnce(0.1).mockReturnValueOnce(0.9);
    const first = computeWebhookBackoffMs(3, 1000, 8000);
    const second = computeWebhookBackoffMs(3, 1000, 8000);
    expect(first).not.toBe(second);
    random.mockRestore();
  });
});
