import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookEventPayload } from './webhook-events';
import { signPayload } from './webhook-signature';
import { WebhookDestinationGuard } from './webhook-destination.guard';
import type {
  WebhookDelivery,
  WebhookEndpoint,
} from '../../generated/prisma/client';

describe('WebhookDispatcherService', () => {
  const endpoint = {
    id: 'we_1',
    url: 'https://integrator.example.com/hook',
    secret: 'whsec_test',
    previousSecret: null as string | null,
    previousSecretExpiresAt: null as Date | null,
    enabled: true,
    destinationBlocked: false,
    eventTypes: [] as string[],
  };

  const webhookCfg = {
    maxAttempts: 8,
    backoffMs: 2000,
    maxBackoffMs: 3600000,
    timeoutMs: 1000,
    connectTimeoutMs: 50,
    readTimeoutMs: 50,
    maxResponseBytes: 1024,
    signatureHeader: 'x-cosmos-signature',
    fanoutConcurrency: 5,
    workerIntervalMs: 1000,
    workerBatchSize: 50,
    leaseMs: 30000,
    pauseAfterFailures: 5,
  };

  function v1Tokens(header: string): string[] {
    return header
      .split(',')
      .filter((part) => part.startsWith('v1='))
      .map((part) => part.slice(3));
  }

  function headerTs(header: string): number {
    return Number(header.split(',')[0].replace('t=', ''));
  }

  function sampleDelivery(
    overrides?: Partial<WebhookDelivery>,
  ): WebhookDelivery {
    return {
      id: 'wd_1',
      endpointId: endpoint.id,
      eventType: 'PAYMENT_INTENT_CREATED',
      eventId: 'evt_1',
      payload: {
        id: 'evt_1',
        type: 'PAYMENT_INTENT_CREATED',
        createdAt: '2026-01-01T00:00:00.000Z',
        data: { id: 'pi_1' },
      },
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 8,
      responseStatus: null,
      error: null,
      lastAttemptAt: null,
      nextAttemptAt: new Date(0),
      leaseUntil: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function build(
    destinations?: WebhookDestinationGuard,
    endpointOverride?: Partial<typeof endpoint>,
    cfgOverride?: Partial<typeof webhookCfg>,
  ) {
    const ep = { ...endpoint, ...endpointOverride };
    const cfg = { ...webhookCfg, ...cfgOverride };
    const prisma = {
      webhookEndpoint: {
        findMany: jest.fn().mockResolvedValue([ep]),
        findUnique: jest.fn().mockResolvedValue(ep),
        update: jest.fn(({ data }: any) => Promise.resolve({ ...ep, ...data })),
      },
      webhookDelivery: {
        create: jest.fn(({ data }: any) =>
          Promise.resolve({ id: 'wd_1', attempts: 0, ...data }),
        ),
        update: jest.fn(({ data }: any) =>
          Promise.resolve({ id: 'wd_1', ...data }),
        ),
      },
    };
    const config = { get: () => cfg } as any;
    const guard = destinations ?? new WebhookDestinationGuard();
    if (!destinations) {
      guard.replaceDnsLookup(async () => ['93.184.216.34']);
    }
    const service = new WebhookDispatcherService(prisma as any, config, guard);
    return { service, prisma, guard, endpoint: ep, cfg };
  }

  afterEach(() => jest.restoreAllMocks());

  it('handleEvent enqueues without calling fetch', async () => {
    const { service, prisma } = build();
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_CREATED', {
        id: 'pi_1',
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(1);
    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PENDING',
          maxAttempts: webhookCfg.maxAttempts,
          nextAttemptAt: expect.any(Date),
        }),
      }),
    );

    const body = prisma.webhookDelivery.create.mock.calls[0][0].data.payload;
    expect(Object.keys(body)).toEqual(['id', 'type', 'createdAt', 'data']);
    expect(body.id).toMatch(/^evt_/);
    expect(body.type).toBe('PAYMENT_INTENT_CREATED');
    expect(body.data).toEqual({ id: 'pi_1' });
  });

  it('attemptOnce signs the payload and POSTs to the endpoint', async () => {
    const { service } = build();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
    });
    global.fetch = fetchMock as any;

    const result = await service.attemptOnce(
      endpoint as WebhookEndpoint,
      sampleDelivery(),
    );

    expect(result).toEqual({
      ok: true,
      responseStatus: 200,
      error: null,
      fatal: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(endpoint.url);
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeDefined();
    expect(init.headers['x-cosmos-event']).toBe('PAYMENT_INTENT_CREATED');
    expect(init.headers['x-cosmos-event-id']).toBe('evt_1');
    expect(init.headers['x-cosmos-delivery']).toBe('wd_1');

    const header: string = init.headers['x-cosmos-signature'];
    const ts = headerTs(header);
    const tokens = v1Tokens(header);
    expect(tokens).toHaveLength(1);
    expect(signPayload(endpoint.secret, init.body, ts)).toBe(tokens[0]);
  });

  it('skips endpoints not subscribed to the event type', async () => {
    const { service, prisma } = build();
    prisma.webhookEndpoint.findMany.mockResolvedValueOnce([
      { ...endpoint, eventTypes: ['PAYMENT_INTENT_SUCCEEDED'] },
    ]);
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_CREATED', {
        id: 'pi_3',
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
  });

  it('revalidates DNS before attemptOnce and does not fetch when DNS flips to private', async () => {
    const guard = new WebhookDestinationGuard();
    let lookups = 0;
    guard.replaceDnsLookup(async () => {
      lookups += 1;
      return lookups === 1 ? ['93.184.216.34'] : ['10.0.0.8'];
    });

    await expect(
      guard.assertSafe('https://integrator.example.com/hook'),
    ).resolves.toBeUndefined();

    const { service, prisma } = build(guard);
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const result = await service.attemptOnce(
      endpoint as WebhookEndpoint,
      sampleDelivery(),
    );

    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.error).toMatch(/private/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.webhookEndpoint.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          destinationBlocked: true,
          enabled: false,
        }),
      }),
    );
  });

  it('does not follow redirects (redirect: manual)', async () => {
    const { service } = build();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 302,
      body: null,
    });
    global.fetch = fetchMock as any;

    const result = await service.attemptOnce(
      endpoint as WebhookEndpoint,
      sampleDelivery(),
    );

    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/302/);
  });

  it('durante la gracia el header trae dos tokens v1 y el secreto viejo verifica OK', async () => {
    const oldSecret = 'whsec_aaa';
    const newSecret = 'whsec_bbb';
    const { service, endpoint: ep } = build(undefined, {
      secret: newSecret,
      previousSecret: oldSecret,
      previousSecretExpiresAt: new Date(Date.now() + 86_400_000),
    });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
    });
    global.fetch = fetchMock as any;

    await service.attemptOnce(ep as WebhookEndpoint, sampleDelivery());

    const header: string =
      fetchMock.mock.calls[0][1].headers['x-cosmos-signature'];
    const ts = headerTs(header);
    const body: string = fetchMock.mock.calls[0][1].body;
    const tokens = v1Tokens(header);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBe(signPayload(newSecret, body, ts));
    expect(tokens[1]).toBe(signPayload(oldSecret, body, ts));
  });

  it('pasada la gracia el secreto viejo ya no verifica', async () => {
    const oldSecret = 'whsec_aaa';
    const newSecret = 'whsec_bbb';
    const { service, endpoint: ep } = build(undefined, {
      secret: newSecret,
      previousSecret: oldSecret,
      previousSecretExpiresAt: new Date(Date.now() - 1000),
    });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
    });
    global.fetch = fetchMock as any;

    await service.attemptOnce(ep as WebhookEndpoint, sampleDelivery());

    const header: string =
      fetchMock.mock.calls[0][1].headers['x-cosmos-signature'];
    const ts = headerTs(header);
    const body: string = fetchMock.mock.calls[0][1].body;
    const tokens = v1Tokens(header);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toBe(signPayload(newSecret, body, ts));
    expect(tokens[0]).not.toBe(signPayload(oldSecret, body, ts));
  });

  it('graceSeconds=0 revoca al instante', async () => {
    const oldSecret = 'whsec_aaa';
    const newSecret = 'whsec_bbb';
    const { service, endpoint: ep } = build(undefined, {
      secret: newSecret,
      previousSecret: null,
      previousSecretExpiresAt: null,
    });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
    });
    global.fetch = fetchMock as any;

    await service.attemptOnce(ep as WebhookEndpoint, sampleDelivery());

    const header: string =
      fetchMock.mock.calls[0][1].headers['x-cosmos-signature'];
    const ts = headerTs(header);
    const body: string = fetchMock.mock.calls[0][1].body;
    const tokens = v1Tokens(header);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toBe(signPayload(newSecret, body, ts));
    expect(tokens[0]).not.toBe(signPayload(oldSecret, body, ts));
  });

  it('ping also signs with both secrets during the grace window', async () => {
    const oldSecret = 'whsec_aaa';
    const newSecret = 'whsec_bbb';
    const { service, endpoint: ep } = build(undefined, {
      secret: newSecret,
      previousSecret: oldSecret,
      previousSecretExpiresAt: new Date(Date.now() + 86_400_000),
    });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
    });
    global.fetch = fetchMock as any;

    const result = await service.pingEndpoint(ep as any);
    expect(result.ok).toBe(true);

    const header: string =
      fetchMock.mock.calls[0][1].headers['x-cosmos-signature'];
    const ts = headerTs(header);
    const body: string = fetchMock.mock.calls[0][1].body;
    const tokens = v1Tokens(header);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBe(signPayload(newSecret, body, ts));
    expect(tokens[1]).toBe(signPayload(oldSecret, body, ts));
  });

  it('redeliver requeues without calling fetch', async () => {
    const { service, prisma } = build();
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const updated = await service.redeliver(sampleDelivery({ attempts: 3 }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.webhookEndpoint.findUnique).toHaveBeenCalledWith({
      where: { id: endpoint.id },
    });
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'wd_1' },
        data: expect.objectContaining({
          status: 'PENDING',
          attempts: 0,
          leaseUntil: null,
          nextAttemptAt: expect.any(Date),
        }),
      }),
    );
    expect(updated.status).toBe('PENDING');
  });

  it('fan-out does not enqueue more than N deliveries in flight', async () => {
    const endpoints = Array.from({ length: 20 }, (_, i) => ({
      ...endpoint,
      id: `we_${i}`,
    }));
    const { service, prisma } = build(undefined, undefined, {
      fanoutConcurrency: 5,
    });
    prisma.webhookEndpoint.findMany.mockResolvedValue(endpoints);

    let inFlight = 0;
    let maxInFlight = 0;
    prisma.webhookDelivery.create.mockImplementation(async ({ data }: any) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      return { id: `wd_${data.endpointId}`, attempts: 0, ...data };
    });

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_CREATED', {
        id: 'pi_burst',
      }),
    );

    expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(20);
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBe(5);
  });

  it('logs enqueue failures instead of rejecting handleEvent', async () => {
    const { service, prisma } = build();
    prisma.webhookDelivery.create.mockRejectedValueOnce(new Error('db down'));
    const errorSpy = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation();

    await expect(
      service.handleEvent(
        new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_CREATED', {
          id: 'pi_err',
        }),
      ),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
  });
});
