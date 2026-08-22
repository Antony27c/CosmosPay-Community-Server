import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Account, Horizon, Keypair } from '@stellar/stellar-sdk';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Full CRUD for Stellar payment intents behind the APISIX gate. Horizon and
 * Prisma are mocked so no real network or database is required; the Prisma mock
 * keeps a tiny in-memory store so create→read→update→delete stays consistent.
 */
describe('Payment intents CRUD (e2e)', () => {
  let app: INestApplication;

  const source = Keypair.random().publicKey();
  const destination = Keypair.random().publicKey();

  // Minimal in-memory store keyed by id.
  const store = new Map<string, any>();
  const transitions: any[] = [];
  let seq = 0;

  const prismaMock: any = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: async (arg: any) => {
      if (typeof arg === 'function') return arg(prismaMock);
      return Promise.all(arg);
    },
    consumer: {
      upsert: jest
        .fn()
        .mockResolvedValue({ id: 'c1', apisixUsername: 'cosmos_u1' }),
    },
    customer: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'cust_1' }),
    },
    // The webhook dispatcher reacts to emitted events; no endpoints registered here.
    webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]) },
    requestLog: {
      create: jest.fn().mockResolvedValue({ id: 'rl_1' }),
    },

    paymentIntent: {
      create: jest.fn(({ data }: any) => {
        const row = {
          id: `pi_${++seq}`,
          txHash: null,
          reference: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        store.set(row.id, row);
        return Promise.resolve(row);
      }),
      findMany: jest.fn(() => Promise.resolve([...store.values()])),
      count: jest.fn(() => Promise.resolve(store.size)),
      findFirst: jest.fn(({ where }: any) =>
        Promise.resolve(store.get(where.id) ?? null),
      ),
      findUnique: jest.fn(({ where }: any) => {
        if (where?.id) {
          return Promise.resolve(store.get(where.id) ?? null);
        }
        const memo = where?.consumerId_memo?.memo;
        const found = [...store.values()].find((r) => r.memo === memo);
        return Promise.resolve(found ?? null);
      }),
      findUniqueOrThrow: jest.fn(({ where }: any) => {
        const row = store.get(where.id);
        if (!row) return Promise.reject(new Error('not found'));
        return Promise.resolve(row);
      }),
      update: jest.fn(({ where, data }: any) => {
        const row = { ...store.get(where.id), ...data, updatedAt: new Date() };
        store.set(where.id, row);
        return Promise.resolve(row);
      }),
      updateMany: jest.fn(({ where, data }: any) => {
        const row = store.get(where.id);
        if (!row || (where.status && row.status !== where.status)) {
          return Promise.resolve({ count: 0 });
        }
        const next = { ...row, ...data, updatedAt: new Date() };
        store.set(where.id, next);
        return Promise.resolve({ count: 1 });
      }),
      delete: jest.fn(({ where }: any) => {
        const row = store.get(where.id);
        store.delete(where.id);
        return Promise.resolve(row);
      }),
    },
    paymentIntentTransition: {
      create: jest.fn(({ data }: any) => {
        const row = {
          id: `tr_${transitions.length + 1}`,
          createdAt: new Date(),
          ...data,
        };
        transitions.push(row);
        return Promise.resolve(row);
      }),
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          transitions.filter((t) => t.intentId === where.intentId),
        ),
      ),
    },
  };

  beforeAll(async () => {
    jest
      .spyOn(Horizon.Server.prototype, 'loadAccount')
      .mockResolvedValue(new Account(source, '123456789') as never);

    // Mock the verification path: a successful tx paying `destination` 25.5 XLM
    // with the matching id memo.
    jest.spyOn(Horizon.Server.prototype, 'transactions').mockReturnValue({
      transaction: () => ({
        call: async () => ({
          successful: true,
          memo_type: 'id',
          memo: '123456789',
        }),
      }),
    } as never);
    jest.spyOn(Horizon.Server.prototype, 'payments').mockReturnValue({
      forTransaction: () => ({
        call: async () => ({
          records: [
            {
              type: 'payment',
              asset_type: 'native',
              to: destination,
              amount: '25.5000000',
            },
          ],
        }),
      }),
    } as never);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
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
  const route = '/v1/payment-intents';
  const txRoute = `${route}/tx`;
  const payRoute = `${route}/pay`;
  const gw = (r: request.Test) =>
    r
      .set('x-gateway-secret', 'topsecret')
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-permissions', 'payments:read,payments:write');

  let createdId: string;

  it('rejects creation without the gateway secret (403)', () =>
    request(http())
      .post(txRoute)
      .send({ source, destination, amount: '25.5' })
      .expect(403));

  it('rejects an invalid Stellar address (400)', () =>
    gw(
      request(http())
        .post(txRoute)
        .send({ source: 'bad', destination, amount: '1' }),
    ).expect(400));

  it('creates a TX intent (201) with xdr + tx URI', async () => {
    const res = await gw(
      request(http())
        .post(txRoute)
        .send({ source, destination, amount: '25.5', memo: '123456789' }),
    ).expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe('PENDING');
    expect(res.body.network).toBe('testnet');
    expect(res.body.kind).toBe('TX');
    expect(res.body.memo).toBe('123456789');
    expect(res.body.uri).toContain('web+stellar:tx?xdr=');
    expect(res.body.xdr).toBeTruthy();
    expect(res.body.qr).toContain('data:image/png;base64,');
    createdId = res.body.id;
  });

  it('auto-generates a numeric MEMO_ID when none is provided', async () => {
    const res = await gw(
      request(http())
        .post(txRoute)
        .send({ source, destination, amount: '1.5' }),
    ).expect(201);
    expect(res.body.memo).toMatch(/^\d+$/);
  });

  it('is idempotent per (consumer, memo) — same memo returns the same intent', async () => {
    const memo = '5550001';
    const first = await gw(
      request(http())
        .post(txRoute)
        .send({ source, destination, amount: '2', memo }),
    ).expect(201);
    const second = await gw(
      request(http())
        .post(txRoute)
        .send({ source, destination, amount: '999', memo }),
    ).expect(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.amount).toBe('2'); // original wins
  });

  it('network follows the API key type (prod env → public)', async () => {
    const res = await gw(
      request(http())
        .post(txRoute)
        .set('x-consumer-env', 'prod')
        .send({ source, destination, amount: '3', memo: '424242' }),
    ).expect(201);
    expect(res.body.network).toBe('public');
  });

  it('creates a PAY intent (201) with pay URI, no xdr', async () => {
    const res = await gw(
      request(http())
        .post(payRoute)
        .send({ destination, amount: '10', memo: '777' }),
    ).expect(201);
    expect(res.body.kind).toBe('PAY');
    expect(res.body.xdr).toBeNull();
    expect(res.body.uri).toContain('web+stellar:pay?');
    expect(res.body.uri).toContain(`destination=${destination}`);
    expect(res.body.uri).toContain('memo_type=MEMO_ID');
    expect(res.body.qr).toContain('data:image/png;base64,');
  });

  it('PAY defaults to native XLM when no asset is given', async () => {
    const res = await gw(
      request(http()).post(payRoute).send({ destination, amount: '5' }),
    ).expect(201);
    expect(res.body.asset).toBe('native');
  });

  it('rejects a non-native asset without an issuer (400)', () =>
    gw(
      request(http())
        .post(payRoute)
        .send({ destination, amount: '5', assetCode: 'USDC' }),
    ).expect(400));

  it('rejects a TX without amount (400)', () =>
    gw(request(http()).post(txRoute).send({ source, destination })).expect(
      400,
    ));

  it('lists the consumer payment intents (200)', async () => {
    const res = await gw(request(http()).get(route)).expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('gets one by id (200)', async () => {
    const res = await gw(request(http()).get(`${route}/${createdId}`)).expect(
      200,
    );
    expect(res.body.id).toBe(createdId);
    expect(res.body.qr).toContain('data:image/png;base64,');
  });

  it('updates status + txHash (200)', async () => {
    const res = await gw(
      request(http())
        .patch(`${route}/${createdId}`)
        .send({ status: 'SUBMITTED', txHash: 'abc123' }),
    ).expect(200);
    expect(res.body.status).toBe('SUBMITTED');
    expect(res.body.txHash).toBe('abc123');
  });

  it('404s an update on an unknown id', () =>
    gw(
      request(http()).patch(`${route}/nope`).send({ status: 'FAILED' }),
    ).expect(404));

  it('validates a submitted tx and finalizes the intent (SUCCEEDED)', async () => {
    const res = await gw(
      request(http())
        .post(`${route}/${createdId}/validate`)
        .send({ txHash: 'a'.repeat(64) }),
    ).expect(201);
    expect(res.body.valid).toBe(true);
    expect(res.body.status).toBe('SUCCEEDED');
    expect(res.body.paymentIntent.status).toBe('SUCCEEDED');
    expect(res.body.paymentIntent.txHash).toBe('a'.repeat(64));
  });

  it('rejects validation with a malformed txHash (400)', () =>
    gw(
      request(http())
        .post(`${route}/${createdId}/validate`)
        .send({ txHash: 'short' }),
    ).expect(400));

  it('deletes an unpaid intent (200) and then 404s on read', async () => {
    const created = await gw(
      request(http())
        .post(txRoute)
        .send({ source, destination, amount: '1', memo: '888001' }),
    ).expect(201);
    await gw(request(http()).delete(`${route}/${created.body.id}`)).expect(200);
    await gw(request(http()).get(`${route}/${created.body.id}`)).expect(404);
  });

  it('rejects deleting a SUCCEEDED (paid) intent (400)', async () => {
    await gw(request(http()).delete(`${route}/${createdId}`)).expect(400);
  });
});
