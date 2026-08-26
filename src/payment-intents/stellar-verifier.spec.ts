import { Horizon } from '@stellar/stellar-sdk';
import { ServiceUnavailableException } from '@nestjs/common';
import { StellarService } from '../stellar/stellar.service';
import { StellarVerifierService } from './stellar-verifier.service';
import pathPaymentStrictReceiveFixture from './__fixtures__/path_payment_strict_receive.json';
import pathPaymentStrictSendFixture from './__fixtures__/path_payment_strict_send.json';
import createAccountFixture from './__fixtures__/create_account.json';

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

  const nativeTo = (to: string, amount: string, from = 'GPAYER') => ({
    type: 'payment',
    asset_type: 'native',
    to,
    from,
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
    // Destination match with wrong amount → actionable reason (no longer the
    // old "No native payment…" generic). Wrong-destination-only still uses
    // the generic message — covered separately below.
    mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
      nativeTo('GOTHER', '25.5'),
      nativeTo('GDEST', '10'),
    ]);
    const res = await make().verifyByHash(intent, 'c'.repeat(64));
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('amount mismatch (received 10, expected 25.5)');
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

  it('returns exact amount mismatch reason when destination matches', async () => {
    mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
      nativeTo('GDEST', '10'),
    ]);
    const res = await make().verifyByHash(intent, 'f'.repeat(64));
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('amount mismatch (received 10, expected 25.5)');
  });

  it('keeps the first destination mismatch reason, not the last', async () => {
    mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
      {
        type: 'payment',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GISSUER',
        to: 'GDEST',
        from: 'GPAYER',
        amount: '25.5',
      },
      nativeTo('GDEST', '10'),
    ]);
    const res = await make().verifyByHash(intent, 'i'.repeat(64));
    expect(res.valid).toBe(false);
    expect(res.reason).toBe(
      'asset mismatch (received USDC:GISSUER, expected native)',
    );
  });

  it('open-amount intents accept path payment of any delivered amount', async () => {
    const fixture = pathPaymentStrictReceiveFixture;
    const openIntent: any = {
      ...intent,
      destination: fixture.to,
      amount: null,
      asset: fixture.asset_code,
      assetIssuer: fixture.asset_issuer,
    };
    mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
      fixture,
    ]);
    const res = await make().verifyByHash(openIntent, fixture.transaction_hash);
    expect(res.valid).toBe(true);
    expect(res.payer).toBe(fixture.from);
  });

  it('returns generic reason when no op targets the destination', async () => {
    mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
      nativeTo('GOTHER', '25.5'),
    ]);
    const res = await make().verifyByHash(intent, 'g'.repeat(64));
    expect(res.valid).toBe(false);
    expect(res.reason).toBe(
      'No payment in this transaction matches the destination/amount',
    );
  });

  it('accepts path_payment_strict_receive from a real Horizon fixture', async () => {
    const fixture = pathPaymentStrictReceiveFixture;
    const pathIntent: any = {
      ...intent,
      destination: fixture.to,
      amount: fixture.amount,
      asset: fixture.asset_code,
      assetIssuer: fixture.asset_issuer,
    };
    mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
      fixture,
    ]);
    const res = await make().verifyByHash(pathIntent, fixture.transaction_hash);
    expect(res.valid).toBe(true);
    expect(res.payer).toBe(fixture.from);
  });

  it('accepts path_payment_strict_send from a real Horizon fixture', async () => {
    const fixture = pathPaymentStrictSendFixture;
    const pathIntent: any = {
      ...intent,
      destination: fixture.to,
      amount: fixture.amount,
      asset: 'native',
      assetIssuer: null,
    };
    mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
      fixture,
    ]);
    const res = await make().verifyByHash(pathIntent, fixture.transaction_hash);
    expect(res.valid).toBe(true);
    expect(res.payer).toBe(fixture.from);
  });

  it('accepts create_account and sets payer from funder', async () => {
    const fixture = createAccountFixture;
    const createIntent: any = {
      ...intent,
      destination: fixture.account,
      amount: fixture.starting_balance,
      asset: 'native',
      assetIssuer: null,
    };
    mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
      fixture,
    ]);
    const res = await make().verifyByHash(
      createIntent,
      fixture.transaction_hash,
    );
    expect(res.valid).toBe(true);
    expect(res.payer).toBe(fixture.funder);
    expect(res.payer).toBeDefined();
  });

  it('accepts a payment with to_muxed when to is the base destination', async () => {
    mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
      {
        ...nativeTo('GDEST', '25.5000000', 'GPAYER'),
        to_muxed: 'MBASENOTHINGJUSTDEFENSIVE000000000000000000000000000000000',
        to_muxed_id: '1',
      },
    ]);
    const res = await make().verifyByHash(intent, 'h'.repeat(64));
    expect(res.valid).toBe(true);
    expect(res.payer).toBe('GPAYER');
  });

  it('verifyByHash payer comes from normalizeOperation (not PaymentOperationRecord cast)', async () => {
    const fixture = createAccountFixture;
    const createIntent: any = {
      ...intent,
      destination: fixture.account,
      amount: fixture.starting_balance,
      asset: 'native',
      assetIssuer: null,
    };
    // create_account has no `from`; only funder — proves payer is normalized.
    expect((fixture as { from?: string }).from).toBeUndefined();
    expect(fixture.funder).toBeDefined();
    mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
      fixture,
    ]);
    const res = await make().verifyByHash(
      createIntent,
      fixture.transaction_hash,
    );
    expect(res.payer).toBe(fixture.funder);
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
    expect(prisma.horizonAccountCursor.findUnique).toHaveBeenCalledWith({
      where: { intentId: 'pi_scan' },
      select: { pagingToken: true },
    });
    expect(res.valid).toBe(true);
    expect(res.txHash).toBe('tx_after_cursor');
    expect(prisma.horizonAccountCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { intentId: 'pi_scan' },
        create: expect.objectContaining({
          intentId: 'pi_scan',
          network: 'testnet',
          account: 'GDEST',
          pagingToken: '150',
        }),
        update: expect.objectContaining({ pagingToken: '150' }),
      }),
    );
  });

  it('does not let one intent consume a co-located intent cursor', async () => {
    const intentA: any = {
      ...intent,
      id: 'pi_a',
      memo: '111',
    };
    const intentB: any = {
      ...intent,
      id: 'pi_b',
      memo: '222',
    };
    // Shared destination: A scans past B's payment (wrong memo) and persists.
    // B must still cold-start (no cursor of its own) and find its payment.
    const paymentForB = paymentOp({
      paging_token: '120',
      transaction_hash: 'tx_b',
      amount: '10.0000000',
    });
    const paymentForA = paymentOp({
      paging_token: '130',
      transaction_hash: 'tx_a',
      amount: '10.0000000',
    });

    const cursors = new Map<string, string>();
    prisma.horizonAccountCursor.findUnique.mockImplementation(
      async ({ where }: { where: { intentId: string } }) => {
        const token = cursors.get(where.intentId);
        return token ? { pagingToken: token } : null;
      },
    );
    prisma.horizonAccountCursor.upsert.mockImplementation(
      async ({
        where,
        create,
        update,
      }: {
        where: { intentId: string };
        create: { pagingToken: string };
        update: { pagingToken: string };
      }) => {
        cursors.set(where.intentId, update.pagingToken ?? create.pagingToken);
        return {};
      },
    );

    mockAccountPayments({
      none: [paymentForA, paymentForB],
    });
    jest.spyOn(Horizon.Server.prototype, 'transactions').mockReturnValue({
      transaction: (hash: string) => ({
        call: async () => ({
          successful: true,
          memo_type: 'id',
          memo: hash === 'tx_a' ? '111' : '222',
        }),
      }),
    } as any);

    const resA = await make().findMatchingPayment(intentA);
    expect(resA.valid).toBe(true);
    expect(resA.txHash).toBe('tx_a');
    expect(cursors.get('pi_a')).toBeDefined();
    expect(cursors.has('pi_b')).toBe(false);

    // Reset Horizon call tracking; B still has no cursor → DESC cold start.
    orderCalls = [];
    cursorCalls = [];
    mockAccountPayments({
      none: [paymentForA, paymentForB],
    });
    jest.spyOn(Horizon.Server.prototype, 'transactions').mockReturnValue({
      transaction: (hash: string) => ({
        call: async () => ({
          successful: true,
          memo_type: 'id',
          memo: hash === 'tx_a' ? '111' : '222',
        }),
      }),
    } as any);

    const resB = await make().findMatchingPayment(intentB);
    expect(orderCalls[0]).toBe('desc');
    expect(resB.valid).toBe(true);
    expect(resB.txHash).toBe('tx_b');
    expect(cursors.get('pi_b')).toBeDefined();
    expect(cursors.get('pi_a')).not.toBe(cursors.get('pi_b'));
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

  it('findMatchingPayment payer comes from normalizeOperation (create_account funder)', async () => {
    const fixture = createAccountFixture;
    expect((fixture as { from?: string }).from).toBeUndefined();
    const createIntent: any = {
      ...intent,
      destination: fixture.account,
      amount: fixture.starting_balance,
      asset: 'native',
      assetIssuer: null,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    };
    mockSuccessfulTx();
    mockAccountPayments({
      none: [
        {
          ...fixture,
          paging_token: '400',
          created_at: '2026-08-25T13:00:00.000Z',
        },
      ],
    });

    const res = await make().findMatchingPayment(createIntent);
    expect(res.valid).toBe(true);
    expect(res.payer).toBe(fixture.funder);
    expect(res.txHash).toBe(fixture.transaction_hash);
  });
});
