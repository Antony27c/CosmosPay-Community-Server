import { BadRequestException, ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaymentIntentsService } from './payment-intents.service';
import { InvalidPaymentIntentTransitionError } from './payment-intent-state-machine';

describe('PaymentIntentsService.transition (guards + audit)', () => {
  const intentBase = {
    id: 'pi_1',
    consumerId: 'c1',
    kind: 'TX',
    source: 'GSRC',
    destination: 'GDEST',
    amount: '25.5',
    asset: 'native',
    assetIssuer: null,
    memo: '123',
    network: 'testnet',
    msg: null,
    callback: null,
    status: 'PENDING' as string,
    xdr: 'xdr',
    uri: 'web+stellar:tx?xdr=xdr',
    txHash: null as string | null,
    reference: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  let row: typeof intentBase;
  let prisma: any;
  let events: EventEmitter2;
  let service: PaymentIntentsService;
  let auditCreates: any[];

  beforeEach(() => {
    row = { ...intentBase };
    auditCreates = [];

    prisma = {
      paymentIntent: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === row.id ? { ...row } : null,
        ),
        updateMany: jest.fn(async ({ where, data }: any) => {
          if (where.id !== row.id || where.status !== row.status) {
            return { count: 0 };
          }
          row = { ...row, ...data, updatedAt: new Date() };
          return { count: 1 };
        }),
        findFirst: jest.fn(async ({ where }: any) =>
          where.id === row.id ? { ...row } : null,
        ),
        findUniqueOrThrow: jest.fn(async ({ where }: any) => {
          if (where.id !== row.id) throw new Error('not found');
          return { ...row };
        }),
      },
      paymentIntentTransition: {
        create: jest.fn(async ({ data }: any) => {
          const created = { id: `tr_${auditCreates.length + 1}`, ...data };
          auditCreates.push(created);
          return created;
        }),
        findMany: jest.fn(async ({ where }: any) =>
          auditCreates.filter((t) => t.intentId === where.intentId),
        ),
      },
      $transaction: jest.fn(async (fn: any) => {
        if (typeof fn === 'function') {
          return fn(prisma);
        }
        return Promise.all(fn);
      }),
      customer: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    };

    events = { emit: jest.fn() } as any;
    const config = {
      get: () => ({
        network: 'testnet',
        baseFee: '100',
        timeoutSeconds: 300,
        ttlSeconds: 3600,
        horizon: { public: 'https://h', testnet: 'https://h' },
      }),
    } as any;

    service = new PaymentIntentsService(
      config,
      prisma,
      events,
      {} as any,
      {} as any,
    );
  });

  it('applies a declared transition with an optimistic status guard and writes audit', async () => {
    const updated = await service.transition(row.id, 'SUBMITTED', {
      consumerUsername: 'cosmos_u1',
      actor: 'api',
      reason: 'merchant reported submission',
      txHash: 'abc123',
    });

    expect(prisma.paymentIntent.updateMany).toHaveBeenCalledWith({
      where: { id: 'pi_1', status: 'PENDING' },
      data: expect.objectContaining({
        status: 'SUBMITTED',
        txHash: 'abc123',
      }),
    });
    expect(auditCreates).toHaveLength(1);
    expect(auditCreates[0]).toMatchObject({
      intentId: 'pi_1',
      fromStatus: 'PENDING',
      toStatus: 'SUBMITTED',
      actor: 'api',
      txHash: 'abc123',
    });
    expect(updated.status).toBe('SUBMITTED');
    expect(events.emit).toHaveBeenCalled();
  });

  it('rejects an undeclared transition with an explicit error', async () => {
    row.status = 'EXPIRED';
    await expect(
      service.transition(row.id, 'SUCCEEDED', {
        consumerUsername: 'cosmos_u1',
        actor: 'api',
        txHash: 'a'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    try {
      await service.transition(row.id, 'SUCCEEDED', {
        consumerUsername: 'cosmos_u1',
        actor: 'api',
        txHash: 'a'.repeat(64),
      });
    } catch (err) {
      const e = err as BadRequestException;
      const body = e.getResponse() as any;
      expect(JSON.stringify(body)).toMatch(/INVALID_PAYMENT_INTENT_TRANSITION|Invalid payment intent transition/);
      expect(prisma.paymentIntent.updateMany).not.toHaveBeenCalled();
      expect(auditCreates).toHaveLength(0);
    }
  });

  it('rejects SUCCEEDED without on-chain txHash', async () => {
    await expect(
      service.transition(row.id, 'SUCCEEDED', {
        consumerUsername: 'cosmos_u1',
        actor: 'validate',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.paymentIntent.updateMany).not.toHaveBeenCalled();
  });

  it('fails closed when the prior-status DB guard matches zero rows', async () => {
    prisma.paymentIntent.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.transition(row.id, 'SUBMITTED', {
        consumerUsername: 'cosmos_u1',
        actor: 'api',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(auditCreates).toHaveLength(0);
  });

  it('routes markSucceeded through the guarded transition', async () => {
    const spy = jest.spyOn(service, 'transition');
    await service.markSucceeded(row.id, 'cosmos_u1', 'd'.repeat(64), 'GPAYER');
    expect(spy).toHaveBeenCalledWith(
      row.id,
      'SUCCEEDED',
      expect.objectContaining({
        consumerUsername: 'cosmos_u1',
        actor: 'validate',
        txHash: 'd'.repeat(64),
        payer: 'GPAYER',
      }),
    );
  });

  it('surfaces InvalidPaymentIntentTransitionError.code to API callers', () => {
    const err = new InvalidPaymentIntentTransitionError(
      'EXPIRED',
      'SUCCEEDED',
      'status EXPIRED is terminal and cannot be abandoned',
    );
    expect(err.code).toBe('INVALID_PAYMENT_INTENT_TRANSITION');
  });
});
