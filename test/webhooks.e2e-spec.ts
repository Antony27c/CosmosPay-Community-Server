import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { WebhookDestinationGuard } from '../src/webhooks/webhook-destination.guard';
import { WebhookSecretCleanupService } from '../src/webhooks/webhook-secret-cleanup.service';
import { signPayload } from '../src/webhooks/webhook-signature';

/**
 * Full CRUD for webhook endpoints behind the APISIX gate. Prisma is mocked with
 * a tiny in-memory store; global fetch is mocked for the ping test. No DB/network.
 */
describe('Webhooks CRUD (e2e)', () => {
  let app: INestApplication;
  const store = new Map<string, any>();
  let seq = 0;

  const prismaMock = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
    consumer: {
      upsert: jest
        .fn()
        .mockResolvedValue({ id: 'c1', apisixUsername: 'cosmos_u1' }),
    },
    requestLog: {
      create: jest.fn().mockResolvedValue({ id: 'rl_1' }),
    },
    webhookEndpoint: {
      create: jest.fn(({ data }: any) => {
        const row = {
          id: `we_${++seq}`,
          enabled: true,
          destinationBlocked: false,
          description: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        store.set(row.id, row);
        return Promise.resolve(row);
      }),
      findMany: jest.fn(() => Promise.resolve([...store.values()])),
      findFirst: jest.fn(({ where }: any) =>
        Promise.resolve(store.get(where.id) ?? null),
      ),
      update: jest.fn(({ where, data }: any) => {
        const row = { ...store.get(where.id), ...data, updatedAt: new Date() };
        store.set(where.id, row);
        return Promise.resolve(row);
      }),
      updateMany: jest.fn(({ where, data }: any) => {
        const cutoff = where?.previousSecretExpiresAt?.lte as Date | undefined;
        let count = 0;
        for (const [id, row] of store.entries()) {
          const hasPrev = row.previousSecret != null;
          const expired =
            cutoff instanceof Date &&
            row.previousSecretExpiresAt instanceof Date &&
            row.previousSecretExpiresAt <= cutoff;
          if (hasPrev && expired) {
            store.set(id, { ...row, ...data });
            count += 1;
          }
        }
        return Promise.resolve({ count });
      }),
      delete: jest.fn(({ where }: any) => {
        const row = store.get(where.id);
        store.delete(where.id);
        return Promise.resolve(row);
      }),
    },
    webhookDelivery: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'wd_1' }),
      update: jest.fn(({ where, data }: any) =>
        Promise.resolve({ id: where?.id ?? 'wd_1', ...data }),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };

  beforeAll(async () => {
    const destinations = new WebhookDestinationGuard();
    destinations.replaceDnsLookup(async () => ['93.184.216.34']);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(WebhookDestinationGuard)
      .useValue(destinations)
      .compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => app.getHttpServer();
  const route = '/v1/webhooks';
  const gw = (r: request.Test) =>
    r
      .set('x-gateway-secret', 'topsecret')
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-permissions', 'webhooks:read,webhooks:write');

  let id: string;

  it('rejects creation without the gateway secret (403)', () =>
    request(http())
      .post(route)
      .send({ url: 'https://x.example.com/h' })
      .expect(403));

  it('rejects an invalid url (400)', () =>
    gw(request(http()).post(route).send({ url: 'not-a-url' })).expect(400));

  it('rejects a loopback / private / metadata destination (400)', async () => {
    const loopback = await gw(
      request(http()).post(route).send({ url: 'https://127.0.0.1/hooks' }),
    ).expect(400);
    expect(loopback.body.message).toEqual(expect.stringMatching(/loopback/i));

    const privateRange = await gw(
      request(http()).post(route).send({ url: 'https://10.0.0.5/hooks' }),
    ).expect(400);
    expect(privateRange.body.message).toEqual(
      expect.stringMatching(/private/i),
    );

    const metadata = await gw(
      request(http())
        .post(route)
        .send({ url: 'https://169.254.169.254/latest/meta-data' }),
    ).expect(400);
    expect(metadata.body.message).toEqual(
      expect.stringMatching(/link-local|cloud-metadata/i),
    );
  });

  it('creates an endpoint (201) and returns the signing secret', async () => {
    const res = await gw(
      request(http())
        .post(route)
        .send({
          url: 'https://integrator.example.com/hook',
          eventTypes: ['PAYMENT_INTENT_CREATED'],
        }),
    ).expect(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.secret).toMatch(/^whsec_/);
    id = res.body.id;
  });

  it('list/get never expose the secret', async () => {
    const list = await gw(request(http()).get(route)).expect(200);
    expect(list.body[0].secret).toBeUndefined();
    expect(list.body[0].previousSecret).toBeUndefined();
    const one = await gw(request(http()).get(`${route}/${id}`)).expect(200);
    expect(one.body.id).toBe(id);
    expect(one.body.secret).toBeUndefined();
    expect(one.body.previousSecret).toBeUndefined();
  });

  it('updates (pause) an endpoint (200)', async () => {
    const res = await gw(
      request(http()).patch(`${route}/${id}`).send({ enabled: false }),
    ).expect(200);
    expect(res.body.enabled).toBe(false);
  });

  it('rotates the secret (201) returning a new secret and previousSecretExpiresAt', async () => {
    const oldSecret = store.get(id).secret;
    const res = await gw(
      request(http()).post(`${route}/${id}/rotate-secret`),
    ).expect(201);
    expect(res.body.secret).toMatch(/^whsec_/);
    expect(res.body.secret).not.toBe(oldSecret);
    expect(res.body.previousSecret).toBeUndefined();
    expect(res.body.previousSecretExpiresAt).toBeDefined();
  });

  it('GET after rotate returns previousSecretExpiresAt and never previousSecret nor secret', async () => {
    const list = await gw(request(http()).get(route)).expect(200);
    expect(list.body[0].secret).toBeUndefined();
    expect(list.body[0].previousSecret).toBeUndefined();
    expect(list.body[0].previousSecretExpiresAt).toBeDefined();
    const one = await gw(request(http()).get(`${route}/${id}`)).expect(200);
    expect(one.body.secret).toBeUndefined();
    expect(one.body.previousSecret).toBeUndefined();
    expect(one.body.previousSecretExpiresAt).toBeDefined();
  });

  it('pings the endpoint (mocked fetch → ok) with both v1 tokens during grace', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
    });
    global.fetch = fetchMock as any;
    const res = await gw(request(http()).post(`${route}/${id}/ping`)).expect(
      201,
    );
    expect(res.body.ok).toBe(true);
    expect(res.body.responseStatus).toBe(200);

    const header: string =
      fetchMock.mock.calls[0][1].headers['x-cosmos-signature'];
    const v1s = header.split(',').filter((p: string) => p.startsWith('v1='));
    expect(v1s).toHaveLength(2);

    const ts = Number(header.split(',')[0].replace('t=', ''));
    const body: string = fetchMock.mock.calls[0][1].body;
    const row = store.get(id);
    expect(v1s[0].slice(3)).toBe(signPayload(row.secret, body, ts));
    expect(v1s[1].slice(3)).toBe(signPayload(row.previousSecret, body, ts));
  });

  it('second rotate within grace keeps the original previousSecret', async () => {
    const originalPrevious = store.get(id).previousSecret;
    const originalExpiry = store.get(id).previousSecretExpiresAt.getTime();
    const intermediate = store.get(id).secret;
    await gw(request(http()).post(`${route}/${id}/rotate-secret`)).expect(201);
    expect(store.get(id).secret).not.toBe(intermediate);
    expect(store.get(id).previousSecret).toBe(originalPrevious);
    expect(store.get(id).previousSecretExpiresAt.getTime()).toBe(
      originalExpiry,
    );
  });

  it('rejects graceSeconds above the configured maximum (400)', async () => {
    const res = await gw(
      request(http())
        .post(`${route}/${id}/rotate-secret`)
        .send({ graceSeconds: 999_999_999 }),
    ).expect(400);
    expect(JSON.stringify(res.body)).toMatch(
      /cannot exceed the configured maximum/,
    );
  });

  it('graceSeconds=0 revokes immediately (next ping has a single v1)', async () => {
    const oldSecret = store.get(id).secret;
    await gw(
      request(http())
        .post(`${route}/${id}/rotate-secret`)
        .send({ graceSeconds: 0 }),
    ).expect(201);
    expect(store.get(id).previousSecret).toBeNull();

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
    });
    global.fetch = fetchMock as any;
    await gw(request(http()).post(`${route}/${id}/ping`)).expect(201);

    const header: string =
      fetchMock.mock.calls[0][1].headers['x-cosmos-signature'];
    const v1s = header.split(',').filter((p: string) => p.startsWith('v1='));
    expect(v1s).toHaveLength(1);
    const ts = Number(header.split(',')[0].replace('t=', ''));
    const body: string = fetchMock.mock.calls[0][1].body;
    const row = store.get(id);
    expect(v1s[0].slice(3)).toBe(signPayload(row.secret, body, ts));
    expect(v1s[0].slice(3)).not.toBe(signPayload(oldSecret, body, ts));
  });

  it('clears previousSecret in the store once the grace window has expired', async () => {
    await gw(request(http()).post(`${route}/${id}/rotate-secret`)).expect(201);
    expect(store.get(id).previousSecret).toMatch(/^whsec_/);

    store.set(id, {
      ...store.get(id),
      previousSecretExpiresAt: new Date(Date.now() - 1000),
    });

    const cleanup = app.get(WebhookSecretCleanupService);
    await cleanup.tick();

    expect(store.get(id).previousSecret).toBeNull();
    expect(store.get(id).previousSecretExpiresAt).toBeNull();
  });

  it('404s on a foreign/unknown id', () =>
    gw(request(http()).get(`${route}/nope`)).expect(404));

  it('deletes (200) then 404s on read', async () => {
    await gw(request(http()).delete(`${route}/${id}`)).expect(200);
    await gw(request(http()).get(`${route}/${id}`)).expect(404);
  });
});
