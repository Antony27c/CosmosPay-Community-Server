import { Account, Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { toStroops } from '../swaps/swap-math';
import { LiquidityPoolsService } from './liquidity-pools.service';
import { SettlementObserverService } from '../observer/settlement-observer.service';
import { WebhookTerminalEmitter } from '../webhooks/webhook-terminal-emitter.service';
import { WEBHOOK_EVENT } from '../webhooks/webhook-events';

jest.mock('qrcode', () => ({
  __esModule: true,
  default: {
    toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,qq'),
  },
}));

const TX_HASH = 'ab'.repeat(32);
const POOL_ID = 'dd'.repeat(32);
const SOURCE = Keypair.random().publicKey();
const USDC_ISSUER = Keypair.random().publicKey();
const FEE_WALLET = Keypair.random().publicKey();

const consumer: GatewayConsumer = {
  username: 'cosmos_u1',
  credentialId: 'cred_1',
  environment: 'dev',
  role: 'user',
  permissions: ['liquidity:write'],
  organizationId: 'org_1',
  plan: 'pro',
  planSwapFeeBps: 50,
};

function horizonReject(codes: { transaction?: string; operations?: string[] }) {
  const err: any = new Error('Horizon rejected the transaction');
  err.response = { data: { extras: { result_codes: codes } } };
  return err;
}

function matchesWhere(row: any, where: any): boolean {
  if (!where) return true;
  if (where.id && where.id !== row.id) return false;
  if (where.kind && where.kind !== row.kind) return false;
  if (where.consumerId && where.consumerId !== row.consumerId) return false;
  if (where.source && where.source !== row.source) return false;
  if (where.poolId && where.poolId !== row.poolId) return false;
  if (where.sharesReceived === null && row.sharesReceived != null) return false;
  if (where.status !== undefined) {
    if (typeof where.status === 'string') {
      if (row.status !== where.status) return false;
    } else if (where.status.in && !where.status.in.includes(row.status)) {
      return false;
    }
  }
  if (where.consumer?.apisixUsername) {
    if (row.consumer?.apisixUsername !== where.consumer.apisixUsername) {
      return false;
    }
  }
  return true;
}

function createPrisma(seed: any[] = []) {
  const rows = seed.map((r) => ({ ...r }));
  const applySelect = (row: any, select?: any) => {
    if (!select) return { ...row };
    const out: any = {};
    for (const k of Object.keys(select)) if (select[k]) out[k] = row[k];
    return out;
  };
  const prisma: any = {
    rows,
    consumer: {
      upsert: jest.fn(async ({ where, create }: any) => ({
        id: 'c1',
        apisixUsername: where.apisixUsername,
        ...create,
      })),
    },
    liquidityPoolOperation: {
      findMany: jest.fn(async ({ where, select, include }: any) =>
        rows
          .filter((r) => matchesWhere(r, where))
          .map((r) => {
            const copy = applySelect(r, select);
            if (include?.consumer) copy.consumer = r.consumer;
            return copy;
          }),
      ),
      findFirst: jest.fn(async ({ where }: any) => {
        const row = rows.find((r) => matchesWhere(r, where));
        return row ? { ...row } : null;
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        return { ...row };
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const row = rows.find((r) => r.id === where.id);
        return row ? { ...row } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const matched = rows.filter((r) => matchesWhere(r, where));
        for (const row of matched) {
          const next = { ...data };
          if (next.settlementEpoch?.increment != null) {
            row.settlementEpoch =
              (row.settlementEpoch ?? 0) + next.settlementEpoch.increment;
            delete next.settlementEpoch;
          }
          Object.assign(row, next);
        }
        return { count: matched.length };
      }),
      create: jest.fn(async ({ data }: any) => {
        const created = {
          id: `op_${rows.length + 1}`,
          sharesReceived: null,
          settledAmountA: null,
          settledAmountB: null,
          consumer: { apisixUsername: consumer.username },
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows.push(created);
        return { ...created };
      }),
    },
    webhookEmittedEvent: uniqueEmittedEvents(),
  };
  return prisma;
}

/** Simulates the unique index on webhook_emitted_event.dedupKey (P2002). */
function uniqueEmittedEvents() {
  const keys = new Set<string>();
  const tails = new Map<string, Promise<unknown>>();
  return {
    create: jest.fn(async ({ data }: any) => {
      const prev = tails.get(data.dedupKey) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      tails.set(
        data.dedupKey,
        prev.then(
          () => gate,
          () => gate,
        ),
      );
      try {
        await prev.catch(() => undefined);
        if (keys.has(data.dedupKey)) {
          const err: any = new Error(
            'Unique constraint failed on the fields: (`dedupKey`)',
          );
          err.code = 'P2002';
          err.meta = { target: ['dedupKey'] };
          throw err;
        }
        keys.add(data.dedupKey);
        return { id: `wee_${keys.size}`, createdAt: new Date(), ...data };
      } finally {
        release();
      }
    }),
  };
}

function stellarConfig() {
  return {
    network: 'testnet',
    baseFee: '100',
    timeoutSeconds: 300,
    swap: {
      feeWallet: FEE_WALLET,
      feeBps: 50,
      slippageBps: 50,
      maxSlippageBps: 500,
    },
    horizon: { public: 'https://h', testnet: 'https://h' },
  };
}

function mockHorizonAccount(balances: any[]) {
  const account: any = new Account(SOURCE, '1');
  account.balances = balances;
  account.subentry_count = 1;
  return account;
}

function makeStellar(
  overrides: {
    submitTransaction?: jest.Mock;
    effectsCall?: jest.Mock;
    txCall?: jest.Mock;
    loadAccount?: jest.Mock;
    fetchPool?: jest.Mock;
  } = {},
) {
  const effectsCall =
    overrides.effectsCall ??
    jest.fn().mockResolvedValue({
      records: [
        {
          type: 'liquidity_pool_deposited',
          shares_received: '100',
          reserves_deposited: [
            { asset: 'native', amount: '1000' },
            { asset: `USDC:${USDC_ISSUER}`, amount: '100' },
          ],
        },
      ],
    });
  const submitTransaction =
    overrides.submitTransaction ??
    jest.fn().mockResolvedValue({ hash: TX_HASH });
  const txCall =
    overrides.txCall ?? jest.fn().mockResolvedValue({ successful: true });
  const loadAccount =
    overrides.loadAccount ??
    jest.fn().mockResolvedValue(
      mockHorizonAccount([
        { asset_type: 'native', balance: '10000' },
        {
          asset_type: 'liquidity_pool_shares',
          liquidity_pool_id: POOL_ID,
          balance: '100',
        },
      ]),
    );
  const fetchPool =
    overrides.fetchPool ??
    jest.fn().mockResolvedValue({
      id: POOL_ID,
      paging_token: '1',
      fee_bp: 30,
      total_trustlines: '2',
      total_shares: '100',
      reserves: [
        { asset: 'native', amount: '2000' },
        { asset: `USDC:${USDC_ISSUER}`, amount: '200' },
      ],
    });

  const server = {
    submitTransaction,
    effects: () => ({ forTransaction: () => ({ call: effectsCall }) }),
    transactions: () => ({ transaction: () => ({ call: txCall }) }),
    loadAccount,
    liquidityPools: () => ({
      liquidityPoolId: () => ({ call: fetchPool }),
    }),
  };

  return {
    passphrase: jest.fn().mockReturnValue('Test SDF Network ; September 2015'),
    server: jest.fn().mockReturnValue(server),
    call: jest.fn((_network: string, fn: (s: typeof server) => unknown) =>
      fn(server),
    ),
    submitTransaction,
    effectsCall,
    txCall,
    loadAccount,
    fetchPool,
  };
}

function depositRow(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'lp_1',
    consumerId: 'c1',
    kind: 'DEPOSIT',
    status: 'PENDING',
    network: 'testnet',
    source: SOURCE,
    poolId: POOL_ID,
    assetA: 'native',
    assetAIssuer: null,
    assetB: 'USDC',
    assetBIssuer: USDC_ISSUER,
    amountA: '1000',
    amountB: '100',
    shares: null,
    sharesReceived: null,
    settledAmountA: null,
    settledAmountB: null,
    minPrice: '9.9',
    maxPrice: '10.1',
    slippageBps: 50,
    feeBps: 0,
    feeAmountA: '0',
    feeAmountB: '0',
    feeWallet: null,
    xdr: 'AAAA',
    uri: 'web+stellar:tx?xdr=AAAA',
    txHash: TX_HASH,
    settlementEpoch: 0,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    consumer: { apisixUsername: consumer.username },
    ...overrides,
  };
}

describe('LiquidityPoolsService — commission engine', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let stellar: ReturnType<typeof makeStellar>;
  let events: EventEmitter2;
  let service: LiquidityPoolsService;

  beforeEach(() => {
    prisma = createPrisma();
    stellar = makeStellar();
    events = { emit: jest.fn() } as any;
    const config = { get: () => stellarConfig() } as any;
    const webhooks = new WebhookTerminalEmitter(prisma as any, events);
    service = new LiquidityPoolsService(
      config,
      prisma as any,
      webhooks,
      stellar as any,
    );
  });

  describe('costBasis', () => {
    it('counts a settled deposit toward remaining shares and cost', async () => {
      prisma.rows.push(
        depositRow({
          status: 'SUCCEEDED',
          sharesReceived: '100',
          settledAmountA: '1000',
          settledAmountB: '100',
        }),
      );
      const basis = await (service as any).costBasis('c1', SOURCE, POOL_ID);
      expect(basis.depositedShares).toBe(toStroops('100'));
      expect(basis.remainingShares).toBe(toStroops('100'));
      expect(basis.costA).toBe(toStroops('1000'));
      expect(basis.costB).toBe(toStroops('100'));
    });

    it('does not count FAILED deposits — a degraded row would lose the basis', async () => {
      prisma.rows.push(
        depositRow({
          status: 'FAILED',
          sharesReceived: '100',
          settledAmountA: '1000',
          settledAmountB: '100',
        }),
      );
      const basis = await (service as any).costBasis('c1', SOURCE, POOL_ID);
      expect(basis.remainingShares).toBe(0n);
      expect(basis.costA).toBe(0n);
    });

    it('subtracts a succeeded withdraw from remaining shares (partial)', async () => {
      prisma.rows.push(
        depositRow({
          status: 'SUCCEEDED',
          sharesReceived: '100',
          settledAmountA: '1000',
          settledAmountB: '100',
        }),
        depositRow({
          id: 'lp_w1',
          kind: 'WITHDRAW',
          status: 'SUCCEEDED',
          shares: '40',
          sharesReceived: null,
          amountA: '396',
          amountB: '39.6',
        }),
      );
      const basis = await (service as any).costBasis('c1', SOURCE, POOL_ID);
      expect(basis.depositedShares).toBe(toStroops('100'));
      expect(basis.remainingShares).toBe(toStroops('60'));
    });
  });

  describe('captureDepositBasis', () => {
    it('writes sharesReceived and settled amounts for a SUCCEEDED deposit', async () => {
      const row = depositRow({ status: 'SUCCEEDED' });
      prisma.rows.push(row);
      await service.captureDepositBasis(row);
      expect(row.sharesReceived).toBe('100');
      expect(row.settledAmountA).toBe('1000');
      expect(row.settledAmountB).toBe('100');
    });

    it('does not overwrite an already-captured cost basis', async () => {
      const row = depositRow({
        status: 'SUCCEEDED',
        sharesReceived: '100',
        settledAmountA: '1000',
        settledAmountB: '100',
      });
      prisma.rows.push(row);
      stellar.effectsCall.mockResolvedValue({
        records: [
          {
            type: 'liquidity_pool_deposited',
            shares_received: '999',
            reserves_deposited: [
              { asset: 'native', amount: '1' },
              { asset: `USDC:${USDC_ISSUER}`, amount: '1' },
            ],
          },
        ],
      });
      await service.captureDepositBasis(row);
      expect(row.sharesReceived).toBe('100');
      expect(row.settledAmountA).toBe('1000');
      expect(stellar.effectsCall).not.toHaveBeenCalled();
    });

    it('does not write a cost basis onto a FAILED row', async () => {
      const row = depositRow({ status: 'FAILED' });
      prisma.rows.push(row);
      await service.captureDepositBasis(row);
      expect(row.sharesReceived).toBeNull();
      expect(stellar.effectsCall).not.toHaveBeenCalled();
    });
  });

  describe('withdraw', () => {
    function seedSucceededDeposit() {
      prisma.rows.push(
        depositRow({
          status: 'SUCCEEDED',
          sharesReceived: '100',
          settledAmountA: '1000',
          settledAmountB: '100',
        }),
      );
    }

    it('charges commission on a withdraw with a gain', async () => {
      seedSucceededDeposit();
      const op = await service.withdraw(consumer, {
        source: SOURCE,
        poolId: POOL_ID,
        shares: '100',
        slippageBps: 0,
      });
      // Doubled reserves, full exit, 50 bps of (2000-1000) / (200-100).
      expect(op.feeAmountA).toBe('5');
      expect(op.feeAmountB).toBe('0.5');
      expect(op.feeWallet).toBe(FEE_WALLET);
      expect(op.feeBps).toBe(50);
    });

    it('charges nothing on a withdraw with a loss', async () => {
      seedSucceededDeposit();
      stellar.fetchPool.mockResolvedValue({
        id: POOL_ID,
        paging_token: '1',
        fee_bp: 30,
        total_trustlines: '2',
        total_shares: '100',
        reserves: [
          { asset: 'native', amount: '500' },
          { asset: `USDC:${USDC_ISSUER}`, amount: '50' },
        ],
      });
      const op = await service.withdraw(consumer, {
        source: SOURCE,
        poolId: POOL_ID,
        shares: '100',
        slippageBps: 0,
      });
      expect(op.feeAmountA).toBe('0');
      expect(op.feeAmountB).toBe('0');
      expect(op.feeWallet).toBeNull();
    });

    it('charges only the covered shares on a partial withdraw', async () => {
      seedSucceededDeposit();
      const op = await service.withdraw(consumer, {
        source: SOURCE,
        poolId: POOL_ID,
        shares: '40',
        slippageBps: 0,
      });
      expect(op.feeAmountA).toBe('2');
      expect(op.feeAmountB).toBe('0.2');
    });
  });
});

describe('LiquidityPoolsService.submit vs observer (issue #32 race)', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let stellar: ReturnType<typeof makeStellar>;
  let events: EventEmitter2;
  let service: LiquidityPoolsService;
  let observer: SettlementObserverService;

  beforeEach(() => {
    prisma = createPrisma();
    stellar = makeStellar();
    events = { emit: jest.fn() } as any;
    const config = {
      get: (key?: string) =>
        key === 'observer'
          ? { enabled: false, intervalMs: 15_000, batchSize: 50 }
          : stellarConfig(),
    } as any;
    const webhooks = new WebhookTerminalEmitter(prisma as any, events);
    service = new LiquidityPoolsService(
      config,
      prisma as any,
      webhooks,
      stellar as any,
    );
    observer = new SettlementObserverService(
      config,
      prisma as any,
      stellar as any,
      service,
      {} as any,
    );
    jest
      .spyOn(TransactionBuilder, 'fromXDR')
      .mockReturnValue({ hash: () => Buffer.from(TX_HASH, 'hex') } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not degrade a liquidated operation to FAILED when Horizon returns result codes after the observer settled it', async () => {
    // The case that used to fail: observer writes SUCCEEDED + cost basis
    // during submit's Horizon round-trip; submit then treated tx_already_included
    // as a rejection and unconditionally UPDATE'd the row to FAILED, dropping
    // the deposit from cost-basis aggregation (status !== SUCCEEDED).
    const row = depositRow({ status: 'PENDING' });
    prisma.rows.push(row);

    stellar.submitTransaction.mockImplementation(async () => {
      stellar.txCall.mockResolvedValue({ successful: true });
      await (observer as any).reconcileLiquidity(50);
      throw horizonReject({ transaction: 'tx_already_included' });
    });

    const outcome = await service.submit(consumer, row.id, 'signed-xdr');

    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.submitted).toBe(true);
    expect(row.status).toBe('SUCCEEDED');
    expect(row.sharesReceived).toBe('100');
    expect(row.settledAmountA).toBe('1000');
    expect(row.settledAmountB).toBe('100');

    const basis = await (service as any).costBasis('c1', SOURCE, POOL_ID);
    expect(basis.remainingShares).toBe(toStroops('100'));
    expect(basis.costA).toBe(toStroops('1000'));

    const succeeded = (events.emit as unknown as jest.Mock).mock.calls.filter(
      ([name, payload]) =>
        name === WEBHOOK_EVENT && payload.type === 'LIQUIDITY_SUCCEEDED',
    );
    expect(succeeded).toHaveLength(1);
  });

  it('observer FAILED must not overwrite a row submit already marked SUCCEEDED', async () => {
    const row = depositRow({
      status: 'SUCCEEDED',
      sharesReceived: '100',
      settledAmountA: '1000',
      settledAmountB: '100',
    });
    prisma.rows.push(row);

    // Stale read: observer loaded this row while it was still SUBMITTED.
    prisma.liquidityPoolOperation.findMany.mockResolvedValueOnce([
      {
        ...row,
        status: 'SUBMITTED',
        sharesReceived: null,
        settledAmountA: null,
        settledAmountB: null,
        consumer: { apisixUsername: consumer.username },
      },
    ]);
    stellar.txCall.mockResolvedValue({ successful: false });

    await (observer as any).reconcileLiquidity(50);

    expect(row.status).toBe('SUCCEEDED');
    expect(row.sharesReceived).toBe('100');
    expect(row.settledAmountA).toBe('1000');
  });

  it('finalizeFailed is a no-op on SUCCEEDED and never emits LIQUIDITY_FAILED', async () => {
    const row = depositRow({
      status: 'SUCCEEDED',
      sharesReceived: '100',
      settledAmountA: '1000',
      settledAmountB: '100',
    });
    prisma.rows.push(row);

    const result = await service.finalizeFailed(row.id, consumer.username);

    expect(result.applied).toBe(false);
    expect(result.operation.status).toBe('SUCCEEDED');
    expect(row.status).toBe('SUCCEEDED');
    expect(row.sharesReceived).toBe('100');
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('finalizeExpired cannot degrade a liquidated operation', async () => {
    const row = depositRow({
      status: 'SUCCEEDED',
      sharesReceived: '50',
      settledAmountA: '500',
      settledAmountB: '50',
    });
    prisma.rows.push(row);

    const result = await service.finalizeExpired(row.id, 'cosmos_u1');
    expect(result.applied).toBe(false);
    expect(row.status).toBe('SUCCEEDED');
    expect(row.sharesReceived).toBe('50');
  });

  it('observer and submit in parallel emit LIQUIDITY_SUCCEEDED once (used to emit twice)', async () => {
    const row = depositRow({ status: 'PENDING' });
    prisma.rows.push(row);
    stellar.txCall.mockResolvedValue({ successful: true });
    stellar.submitTransaction.mockResolvedValue({ hash: TX_HASH });

    await Promise.all([
      service.submit(consumer, row.id, 'signed-xdr'),
      (observer as any).reconcileLiquidity(50),
    ]);

    expect(row.status).toBe('SUCCEEDED');
    const succeeded = (events.emit as unknown as jest.Mock).mock.calls.filter(
      ([name, payload]) =>
        name === WEBHOOK_EVENT && payload.type === 'LIQUIDITY_SUCCEEDED',
    );
    expect(succeeded).toHaveLength(1);
  });
});
