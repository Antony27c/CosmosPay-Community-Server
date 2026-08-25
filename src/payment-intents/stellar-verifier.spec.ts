import { Horizon } from '@stellar/stellar-sdk';
import { ServiceUnavailableException } from '@nestjs/common';
import { StellarService } from '../stellar/stellar.service';
import { StellarVerifierService } from './stellar-verifier.service';

describe('StellarVerifierService.verifyByHash', () => {
  const intent: any = {
    id: 'pi_1',
    network: 'testnet',
    destination: 'GDEST',
    amount: '25.5',
    asset: 'native',
    assetIssuer: null,
    memo: '123456789',
  };
  const config = {
    get: () => ({
      horizon: {
        public: 'https://horizon.test',
        testnet: 'https://horizon.test',
      },
      httpTimeoutMs: 1000,
      maxAttempts: 1,
      retryBaseMs: 1,
    }),
  } as any;
  const stellar = new StellarService(config);
  const prisma = {
    horizonAccountCursor: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  };
  const make = () => new StellarVerifierService(stellar, prisma as any);

  function mockHorizon(
    tx: { successful: boolean; memo_type?: string; memo?: string },
    paymentRecords: any[],
  ) {
    jest.spyOn(Horizon.Server.prototype, 'transactions').mockReturnValue({
      transaction: () => ({ call: async () => tx }),
    } as any);
    jest.spyOn(Horizon.Server.prototype, 'payments').mockReturnValue({
      forTransaction: () => ({
        call: async () => ({ records: paymentRecords }),
      }),
    } as any);
  }

  const nativeTo = (to: string, amount: string) => ({
    type: 'payment',
    asset_type: 'native',
    to,
    amount,
  });

  afterEach(() => jest.restoreAllMocks());

  it('accepts a successful tx with matching destination, amount and memo', async () => {
    mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
      nativeTo('GDEST', '25.5000000'),
    ]);
    const res = await make().verifyByHash(intent, 'a'.repeat(64));
    expect(res.valid).toBe(true);
  });

  it('rejects a memo mismatch', async () => {
    mockHorizon({ successful: true, memo_type: 'id', memo: '999' }, [
      nativeTo('GDEST', '25.5'),
    ]);
    const res = await make().verifyByHash(intent, 'b'.repeat(64));
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/Memo mismatch/);
  });

  it('rejects when no payment matches destination/amount', async () => {
    mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
      nativeTo('GOTHER', '25.5'),
      nativeTo('GDEST', '10'),
    ]);
    const res = await make().verifyByHash(intent, 'c'.repeat(64));
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/No native payment/);
  });

  it('marks a failed on-chain tx as not valid', async () => {
    mockHorizon({ successful: false }, []);
    const res = await make().verifyByHash(intent, 'd'.repeat(64));
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('Transaction failed on-chain');
  });

  it('maps Horizon 429 through StellarService.call to ServiceUnavailableException', async () => {
    jest.spyOn(Horizon.Server.prototype, 'transactions').mockReturnValue({
      transaction: () => ({
        call: async () => {
          const err = new Error('rate limited') as Error & {
            response: { status: number };
          };
          err.response = { status: 429 };
          throw err;
        },
      }),
    } as any);
    await expect(
      make().verifyByHash(intent, 'e'.repeat(64)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('StellarVerifierService.findMatchingPayment', () => {
  const intentCreatedAt = new Date('2026-08-25T12:00:00.000Z');
  const intent: any = {
    id: 'pi_scan',
    network: 'testnet',
    destination: 'GDEST',
    amount: '10',
    asset: 'native',
    assetIssuer: null,
    memo: '555',
    createdAt: intentCreatedAt,
  };

  const config = {
    get: () => ({
      horizon: {
        public: 'https://horizon.test',
        testnet: 'https://horizon.test',
      },
      httpTimeoutMs: 1000,
      maxAttempts: 1,
      retryBaseMs: 1,
    }),
  } as any;

  let stellar: StellarService;
  let prisma: {
    horizonAccountCursor: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
    };
  };
  let cursorCalls: Array<string | undefined>;
  let orderCalls: string[];

  const make = () => new StellarVerifierService(stellar, prisma as any);

  const paymentOp = (overrides: Record<string, unknown> = {}) => ({
    type: 'payment',
    asset_type: 'native',
    to: 'GDEST',
    from: 'GSOURCE',
    amount: '10.0000000',
    transaction_hash: 'tx_match',
    paging_token: '200',
    created_at: '2026-08-25T13:00:00.000Z',
    ...overrides,
  });

  function mockSuccessfulTx(memo = '555') {
    jest.spyOn(Horizon.Server.prototype, 'transactions').mockReturnValue({
      transaction: () => ({
        call: async () => ({
          successful: true,
          memo_type: 'id',
          memo,
        }),
      }),
    } as any);
  }

  /**
   * Chainable Horizon payments().forAccount() mock.
   * `pagesByCursor` maps starting cursor (undefined = first page) → records.
   */
  function mockAccountPayments(
    pagesByCursor: Record<string, any[]> & { none?: any[] },
  ) {
    cursorCalls = [];
    orderCalls = [];
    jest.spyOn(Horizon.Server.prototype, 'payments').mockReturnValue({
      forAccount: () => {
        const state: { order?: string; limit?: number; cursor?: string } = {};
        const builder: any = {
          order: (o: string) => {
            orderCalls.push(o);
            state.order = o;
            return builder;
          },
          limit: (n: number) => {
            state.limit = n;
            return builder;
          },
          cursor: (c: string) => {
            cursorCalls.push(c);
            state.cursor = c;
            return builder;
          },
          call: async () => {
            const key =
              state.cursor === undefined ? 'none' : String(state.cursor);
            const records = pagesByCursor[key] ?? [];
            return { records };
          },
        };
        return builder;
      },
    } as any);
  }

  beforeEach(() => {
    stellar = new StellarService(config);
    prisma = {
      horizonAccountCursor: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    cursorCalls = [];
    orderCalls = [];
  });

  afterEach(() => jest.restoreAllMocks());

  it('rejects payment earlier than intent.createdAt', async () => {
    mockSuccessfulTx();
    mockAccountPayments({
      none: [
        paymentOp({
          created_at: '2026-08-25T11:00:00.000Z',
          paging_token: '50',
          transaction_hash: 'tx_old',
        }),
      ],
    });

    const res = await make().findMatchingPayment(intent);

    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/No matching payment/);
  });

  it('finds match beyond the old single-page window', async () => {
    mockSuccessfulTx();
    const noise = Array.from({ length: 50 }, (_, i) =>
      paymentOp({
        amount: '1.0000000',
        paging_token: String(1000 - i),
        transaction_hash: `tx_noise_${i}`,
        created_at: '2026-08-25T14:00:00.000Z',
      }),
    );
    const match = paymentOp({
      paging_token: '900',
      transaction_hash: 'tx_deep',
      created_at: '2026-08-25T13:30:00.000Z',
    });
    mockAccountPayments({
      none: noise,
      '951': [match], // after last noise token when pageSize=50 in old code;
      // with pageSize=200 cold-start DESC, second page cursor = last of first page
      [noise[noise.length - 1].paging_token]: [match],
    });

    const res = await make().findMatchingPayment(intent, 50);

    expect(res.valid).toBe(true);
    expect(res.txHash).toBe('tx_deep');
    expect(prisma.horizonAccountCursor.upsert).toHaveBeenCalled();
  });

  it('resumes from persisted cursor', async () => {
    prisma.horizonAccountCursor.findUnique.mockResolvedValue({
      network: 'testnet',
      account: 'GDEST',
      pagingToken: '100',
    });
    mockSuccessfulTx();
    mockAccountPayments({
      none: [], // should not be used — must start from cursor
      '100': [
        paymentOp({
          paging_token: '150',
          transaction_hash: 'tx_after_cursor',
          created_at: '2026-08-25T13:00:00.000Z',
        }),
      ],
    });

    const res = await make().findMatchingPayment(intent);

    expect(orderCalls).toContain('asc');
    expect(cursorCalls).toContain('100');
    expect(res.valid).toBe(true);
    expect(res.txHash).toBe('tx_after_cursor');
    expect(prisma.horizonAccountCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          network_account: { network: 'testnet', account: 'GDEST' },
        },
        create: expect.objectContaining({ pagingToken: '150' }),
        update: expect.objectContaining({ pagingToken: '150' }),
      }),
    );
  });

  it('matches on the first DESC page when no cursor and upserts', async () => {
    mockSuccessfulTx();
    mockAccountPayments({
      none: [
        paymentOp({
          paging_token: '300',
          transaction_hash: 'tx_tip',
        }),
      ],
    });

    const res = await make().findMatchingPayment(intent);

    expect(orderCalls[0]).toBe('desc');
    expect(res.valid).toBe(true);
    expect(res.txHash).toBe('tx_tip');
    expect(prisma.horizonAccountCursor.upsert).toHaveBeenCalled();
  });

  it('maps missing destination account to a clear reason', async () => {
    jest.spyOn(Horizon.Server.prototype, 'payments').mockReturnValue({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            call: async () => {
              const err = new Error('not found') as Error & {
                response: { status: number };
              };
              err.response = { status: 404 };
              throw err;
            },
          }),
        }),
      }),
    } as any);

    const res = await make().findMatchingPayment(intent);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('Destination account not found');
  });
});
