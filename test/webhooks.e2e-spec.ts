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
      delete: jest.fn(({ where }: any) => {
        const row = store.get(where.id);
        store.delete(where.id);
        return Promise.resolve(row);
      }),
    },
    webhookDelivery: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    requestLog: {
      create: jest.fn().mockResolvedValue({}),
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
    const one = await gw(request(http()).get(`${route}/${id}`)).expect(200);
    expect(one.body.id).toBe(id);
    expect(one.body.secret).toBeUndefined();
  });

  it('updates (pause) an endpoint (200)', async () => {
    const res = await gw(
      request(http()).patch(`${route}/${id}`).send({ enabled: false }),
    ).expect(200);
    expect(res.body.enabled).toBe(false);
  });

  it('rotates the secret (200) returning a new secret', async () => {
    const res = await gw(
      request(http()).post(`${route}/${id}/rotate-secret`),
    ).expect(201);
    expect(res.body.secret).toMatch(/^whsec_/);
  });

  it('pings the endpoint (mocked fetch → ok)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
    }) as any;
    const res = await gw(request(http()).post(`${route}/${id}/ping`)).expect(
      201,
    );
    expect(res.body.ok).toBe(true);
    expect(res.body.responseStatus).toBe(200);
  });

  it('404s on a foreign/unknown id', () =>
    gw(request(http()).get(`${route}/nope`)).expect(404));

  it('deletes (200) then 404s on read', async () => {
    await gw(request(http()).delete(`${route}/${id}`)).expect(200);
    await gw(request(http()).get(`${route}/${id}`)).expect(404);
  });
});
