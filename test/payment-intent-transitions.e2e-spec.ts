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
 * Issue #36 — payment-intent state-machine guards at the HTTP boundary.
 * Prisma/Horizon are mocked; the in-memory store exercises transition(),
 * optimistic status guards, and the consultable audit trail.
 */
describe('Payment intent transitions (e2e)', () => {
  let app: INestApplication;

  const source = Keypair.random().publicKey();
  const destination = Keypair.random().publicKey();

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
        if (where?.id) return Promise.resolve(store.get(where.id) ?? null);
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
          transitions
            .filter((t) => t.intentId === where.intentId)
            .sort(
              (a, b) =>
                a.createdAt.getTime() - b.createdAt.getTime(),
            ),
        ),
      ),
    },
  };

  beforeAll(async () => {
    jest
      .spyOn(Horizon.Server.prototype, 'loadAccount')
      .mockResolvedValue(new Account(source, '123456789') as never);

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
  const gw = (r: request.Test) =>
    r
      .set('x-gateway-secret', 'topsecret')
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-permissions', 'payments:read,payments:write');

  async function createPending(memo: string) {
    const res = await gw(
      request(http())
        .post(`${route}/tx`)
        .send({ source, destination, amount: '25.5', memo }),
    ).expect(201);
    return res.body as { id: string; status: string };
  }

  it('rejects forcing EXPIRED → SUCCEEDED with an explicit 400', async () => {
    const intent = await createPending('900001');
    // Move to a terminal state first.
    await gw(
      request(http())
        .patch(`${route}/${intent.id}`)
        .send({ status: 'EXPIRED' }),
    ).expect(200);

    const res = await gw(
      request(http())
        .patch(`${route}/${intent.id}`)
        .send({ status: 'SUCCEEDED', txHash: 'a'.repeat(64) }),
    ).expect(400);

    expect(res.body.code).toBe('INVALID_PAYMENT_INTENT_TRANSITION');
    expect(res.body.message).toMatch(/Invalid payment intent transition/);
    expect(res.body.from).toBe('EXPIRED');
    expect(res.body.to).toBe('SUCCEEDED');
  });

  it('rejects PENDING → SUCCEEDED without on-chain txHash', async () => {
    const intent = await createPending('900002');
    const res = await gw(
      request(http())
        .patch(`${route}/${intent.id}`)
        .send({ status: 'SUCCEEDED' }),
    ).expect(400);

    expect(res.body.code).toBe('INVALID_PAYMENT_INTENT_TRANSITION');
    expect(res.body.message).toMatch(/txHash/);
  });

  it('records a consultable transition history', async () => {
    const intent = await createPending('900003');
    await gw(
      request(http())
        .patch(`${route}/${intent.id}`)
        .send({ status: 'SUBMITTED', txHash: 'abc123' }),
    ).expect(200);

    const history = await gw(
      request(http()).get(`${route}/${intent.id}/transitions`),
    ).expect(200);

    expect(Array.isArray(history.body)).toBe(true);
    expect(history.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          intentId: intent.id,
          fromStatus: 'PENDING',
          toStatus: 'SUBMITTED',
          actor: 'api',
          txHash: 'abc123',
        }),
      ]),
    );
  });
});
