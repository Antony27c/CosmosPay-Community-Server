import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookEventPayload } from './webhook-events';
import { signPayload } from './webhook-signature';
import { WebhookDestinationGuard } from './webhook-destination.guard';

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
    maxAttempts: 3,
    backoffMs: 1,
    timeoutMs: 1000,
    connectTimeoutMs: 500,
    readTimeoutMs: 1000,
    maxResponseBytes: 1024,
    signatureHeader: 'x-cosmos-signature',
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

  function build(
    destinations?: WebhookDestinationGuard,
    endpointOverride?: Partial<typeof endpoint>,
  ) {
    const ep = { ...endpoint, ...endpointOverride };
    const prisma = {
      webhookEndpoint: {
        findMany: jest.fn().mockResolvedValue([ep]),
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
    const config = { get: () => webhookCfg } as any;
    const guard = destinations ?? new WebhookDestinationGuard();
    if (!destinations) {
      guard.replaceDnsLookup(async () => ['93.184.216.34']);
    }
    const service = new WebhookDispatcherService(prisma as any, config, guard);
    return { service, prisma, guard, endpoint: ep };
  }

  afterEach(() => jest.restoreAllMocks());

  it('signs the payload and delivers to subscribed endpoints (SUCCEEDED)', async () => {
    const { service, prisma } = build();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
    });
    global.fetch = fetchMock as any;

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_CREATED', {
        id: 'pi_1',
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(endpoint.url);
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeDefined();
    expect(webhookCfg.connectTimeoutMs).toBe(500);
    expect(webhookCfg.readTimeoutMs).toBe(1000);

    // The signature header must be a valid HMAC of `${t}.${body}`.
    const header: string = init.headers['x-cosmos-signature'];
    const ts = headerTs(header);
    const tokens = v1Tokens(header);
    expect(tokens).toHaveLength(1);
    expect(signPayload(endpoint.secret, init.body, ts)).toBe(tokens[0]);

    // Integrator HTTP envelope is unchanged: { id, type, createdAt, data }.
    const body = JSON.parse(init.body);
    expect(Object.keys(body)).toEqual(['id', 'type', 'createdAt', 'data']);
    expect(body.id).toMatch(/^evt_/);
    expect(body.type).toBe('PAYMENT_INTENT_CREATED');
    expect(body.data).toEqual({ id: 'pi_1' });

    // Persisted a delivery and finalized it as SUCCEEDED.
    expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(1);
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SUCCEEDED',
          responseStatus: 200,
        }),
      }),
    );
  });

  it('retries up to maxAttempts then marks FAILED', async () => {
    const { service, prisma } = build();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      body: null,
    });
    global.fetch = fetchMock as any;

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_FAILED', {
        id: 'pi_2',
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(webhookCfg.maxAttempts);
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', attempts: 3 }),
      }),
    );
  });

  it('skips endpoints not subscribed to the event type', async () => {
    const { service, prisma } = build();
    prisma.webhookEndpoint.findMany.mockResolvedValueOnce([
      { ...endpoint, eventTypes: ['PAYMENT_INTENT_SUCCEEDED'] },
    ]);
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
    });
    global.fetch = fetchMock as any;

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_CREATED', {
        id: 'pi_3',
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
  });

  it('revalidates DNS before delivery and does not fetch when DNS flips to private', async () => {
    const guard = new WebhookDestinationGuard();
    let lookups = 0;
    guard.replaceDnsLookup(async () => {
      lookups += 1;
      // First call simulates a safe register-time resolution; delivery sees private.
      return lookups === 1 ? ['93.184.216.34'] : ['10.0.0.8'];
    });

    // Register-time check would pass:
    await expect(
      guard.assertSafe('https://integrator.example.com/hook'),
    ).resolves.toBeUndefined();

    const { service, prisma } = build(guard);
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_CREATED', {
        id: 'pi_dns_flip',
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          error: expect.stringMatching(/private/i),
        }),
      }),
    );
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

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_CREATED', {
        id: 'pi_redirect',
      }),
    );

    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
  });

  it('durante la gracia el header trae dos tokens v1 y el secreto viejo verifica OK', async () => {
    const oldSecret = 'whsec_aaa';
    const newSecret = 'whsec_bbb';
    const { service } = build(undefined, {
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

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_CREATED', {
        id: 'pi_grace',
      }),
    );

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
    const { service } = build(undefined, {
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

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_CREATED', {
        id: 'pi_expired_grace',
      }),
    );

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
    const { service } = build(undefined, {
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

    await service.handleEvent(
      new WebhookEventPayload('cosmos_u1', 'PAYMENT_INTENT_CREATED', {
        id: 'pi_revoke',
      }),
    );

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
});
