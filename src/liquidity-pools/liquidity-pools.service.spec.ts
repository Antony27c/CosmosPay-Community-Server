/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-assertion */
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Account,
  Asset,
  Keypair,
  LiquidityPoolAsset,
  LiquidityPoolFeeV18,
  TransactionBuilder,
  getLiquidityPoolId,
} from '@stellar/stellar-sdk';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import {
  applySlippage,
  computeFee,
  fromStroops,
  toStroops,
} from '../swaps/swap-math';
import { WebhookTerminalEmitter } from '../webhooks/webhook-terminal-emitter.service';
import { LiquidityPoolsService } from './liquidity-pools.service';
import { proportionalShare } from './lp-math';

jest.mock('qrcode', () => ({
  __esModule: true,
  default: {
    toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,qq'),
  },
}));

const PASSPHRASE = 'Test SDF Network ; September 2015';
const TX_HASH = 'ab'.repeat(32);
const POOL_ID = 'dd'.repeat(32);
const POOL_OK_1 = 'aa'.repeat(32);
const POOL_FAIL = 'bb'.repeat(32);
const POOL_OK_2 = 'cc'.repeat(32);
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

function matchesWhere(row: any, where: any): boolean {
  if (!where) return true;
  if (where.OR) {
    const { OR, ...rest } = where;
    if (!matchesWhere(row, rest)) return false;
    return OR.some((clause: any) => matchesWhere(row, clause));
  }
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
    $executeRaw: jest.fn(async () => 0),
  };
  prisma.$transaction = jest.fn(async (arg: any) => {
    if (typeof arg === 'function') {
      return arg({
        $executeRaw: prisma.$executeRaw,
        liquidityPoolOperation: prisma.liquidityPoolOperation,
      });
    }
    return Promise.all(arg);
  });
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

function mockHorizonAccount(balances: any[], subentryCount = 1) {
  const account: any = new Account(SOURCE, '1');
  account.balances = balances;
  account.subentry_count = subentryCount;
  return account;
}

function nativeUsdcPoolId(): string {
  const share = new LiquidityPoolAsset(
    Asset.native(),
    new Asset('USDC', USDC_ISSUER),
    LiquidityPoolFeeV18,
  );
  return getLiquidityPoolId(
    'constant_product',
    share.getLiquidityPoolParameters(),
  ).toString('hex');
}

function poolRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: POOL_ID,
    paging_token: '1',
    fee_bp: 30,
    total_trustlines: '2',
    total_shares: '100',
    reserves: [
      { asset: 'native', amount: '2000' },
      { asset: `USDC:${USDC_ISSUER}`, amount: '200' },
    ],
    ...overrides,
  };
}

function depositAccount(
  opts: {
    hasPoolShare?: boolean;
    native?: string;
    usdc?: string;
    shares?: string;
    sharePoolId?: string;
    subentryCount?: number;
  } = {},
) {
  const balances: any[] = [
    { asset_type: 'native', balance: opts.native ?? '10000' },
    {
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: USDC_ISSUER,
      balance: opts.usdc ?? '10000',
    },
  ];
  if (opts.hasPoolShare) {
    balances.push({
      asset_type: 'liquidity_pool_shares',
      liquidity_pool_id: opts.sharePoolId ?? nativeUsdcPoolId(),
      balance: opts.shares ?? '0',
    });
  }
  return mockHorizonAccount(balances, opts.subentryCount ?? 1);
}

function decodeOps(xdr: string): Array<{ type: string }> {
  const tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE);
  if (!('operations' in tx)) {
    throw new Error('expected a Transaction, not a fee-bump');
  }
  return (tx as { operations: Array<{ type: string }> }).operations;
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
      liquidityPoolId: (id: string) => ({ call: () => fetchPool(id) }),
    }),
  };

  return {
    passphrase: jest.fn().mockReturnValue(PASSPHRASE),
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
    const webhooks = new WebhookTerminalEmitter(prisma, events);
    service = new LiquidityPoolsService(
      config,
      prisma,
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

describe('LiquidityPoolsService — liquidated rows stay liquidated', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: LiquidityPoolsService;
  let emit: jest.Mock;

  beforeEach(() => {
    prisma = createPrisma();
    const stellar = makeStellar();
    emit = jest.fn();
    const events = { emit };
    const config = { get: () => stellarConfig() } as any;
    const webhooks = new WebhookTerminalEmitter(prisma as any, events as any);
    service = new LiquidityPoolsService(
      config,
      prisma as any,
      webhooks,
      stellar as any,
    );
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
    expect(emit).not.toHaveBeenCalled();
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
});

describe('LiquidityPoolsService — issue #20 orchestration', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let stellar: ReturnType<typeof makeStellar>;
  let events: { emit: jest.Mock };
  let service: LiquidityPoolsService;

  function buildService(feeWallet: string = FEE_WALLET) {
    prisma = createPrisma();
    stellar = makeStellar();
    const cfg = stellarConfig();
    cfg.swap.feeWallet = feeWallet;
    const config = { get: () => cfg } as any;
    events = { emit: jest.fn() };
    const webhooks = new WebhookTerminalEmitter(prisma, events as any);
    service = new LiquidityPoolsService(
      config,
      prisma,
      webhooks,
      stellar as any,
    );
  }

  function seedCapturedDeposit() {
    prisma.rows.push(
      depositRow({
        status: 'SUCCEEDED',
        sharesReceived: '100',
        settledAmountA: '1000',
        settledAmountB: '100',
      }),
    );
  }

  beforeEach(() => {
    buildService();
  });

  describe('deposit', () => {
    beforeEach(() => {
      stellar.loadAccount.mockResolvedValue(depositAccount());
      stellar.fetchPool.mockResolvedValue(
        poolRecord({ id: nativeUsdcPoolId() }),
      );
    });

    it('reorders an inverted pair so assetA < assetB and amounts follow the assets', async () => {
      // Caller sent USDC as A / XLM as B. Native sorts first, so the persisted
      // row must swap both the codes and the amounts. Dropping the reorder
      // (deposit lines 248-251) makes LiquidityPoolAsset throw or persists
      // USDC as assetA with amount 100 instead of native/1000.
      const op = await service.deposit(consumer, {
        source: SOURCE,
        assetACode: 'USDC',
        assetAIssuer: USDC_ISSUER,
        assetBCode: 'XLM',
        maxAmountA: '100',
        maxAmountB: '1000',
        slippageBps: 0,
      });
      expect(op.assetA).toBe('native');
      expect(op.assetAIssuer).toBeNull();
      expect(op.amountA).toBe('1000');
      expect(op.assetB).toBe('USDC');
      expect(op.assetBIssuer).toBe(USDC_ISSUER);
      expect(op.amountB).toBe('100');
    });

    it('rejects an empty pool when either amount is omitted', async () => {
      stellar.fetchPool.mockResolvedValue(null);
      const err = await service
        .deposit(consumer, {
          source: SOURCE,
          assetACode: 'XLM',
          assetBCode: 'USDC',
          assetBIssuer: USDC_ISSUER,
          maxAmountA: '1000',
          slippageBps: 0,
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getStatus()).toBe(400);
      expect(err.message).toMatch(/provide both amounts/);
    });

    it('derives the omitted side of a funded pool with matchDeposit', async () => {
      // Reserves 1000 native : 100 USDC → depositing 50 XLM takes 5 USDC.
      stellar.fetchPool.mockResolvedValue(
        poolRecord({
          id: nativeUsdcPoolId(),
          total_shares: '100',
          reserves: [
            { asset: 'native', amount: '1000' },
            { asset: `USDC:${USDC_ISSUER}`, amount: '100' },
          ],
        }),
      );
      const op = await service.deposit(consumer, {
        source: SOURCE,
        assetACode: 'XLM',
        assetBCode: 'USDC',
        assetBIssuer: USDC_ISSUER,
        maxAmountA: '50',
        slippageBps: 0,
      });
      expect(op.amountA).toBe('50');
      expect(op.amountB).toBe('5');
    });

    it('persists feeBps 0 and feeWallet null — deposits never pay commission', async () => {
      const op = await service.deposit(consumer, {
        source: SOURCE,
        assetACode: 'XLM',
        assetBCode: 'USDC',
        assetBIssuer: USDC_ISSUER,
        maxAmountA: '50',
        maxAmountB: '5',
        slippageBps: 0,
      });
      expect(op.feeBps).toBe(0);
      expect(op.feeWallet).toBeNull();
      expect(op.feeAmountA).toBe('0');
      expect(op.feeAmountB).toBe('0');
    });

    it('adds changeTrust only when the account has no pool-share trustline', async () => {
      const op = await service.deposit(consumer, {
        source: SOURCE,
        assetACode: 'XLM',
        assetBCode: 'USDC',
        assetBIssuer: USDC_ISSUER,
        maxAmountA: '50',
        maxAmountB: '5',
        slippageBps: 0,
      });
      const types = decodeOps(op.xdr).map((o) => o.type);
      expect(types).toEqual(['changeTrust', 'liquidityPoolDeposit']);
    });

    it('skips changeTrust when the pool-share trustline already exists', async () => {
      stellar.loadAccount.mockResolvedValue(
        depositAccount({ hasPoolShare: true }),
      );
      const op = await service.deposit(consumer, {
        source: SOURCE,
        assetACode: 'XLM',
        assetBCode: 'USDC',
        assetBIssuer: USDC_ISSUER,
        maxAmountA: '50',
        maxAmountB: '5',
        slippageBps: 0,
      });
      const types = decodeOps(op.xdr).map((o) => o.type);
      expect(types).toEqual(['liquidityPoolDeposit']);
    });
  });

  describe('withdraw', () => {
    it('charges nothing when no cost basis is registered', async () => {
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

    it('charges computeFee(redeemed − basis, feeBps) on a withdraw with a gain', async () => {
      seedCapturedDeposit();
      const op = await service.withdraw(consumer, {
        source: SOURCE,
        poolId: POOL_ID,
        shares: '100',
        slippageBps: 0,
      });
      // 100/100 of doubled reserves 2000/200 → redeemed 2000 A + 200 B.
      // Cost basis 1000/100 → gain 1000 A + 100 B; 50 bps of that.
      const redeemedA = applySlippage(
        proportionalShare(
          toStroops('100'),
          toStroops('100'),
          toStroops('2000'),
        ),
        0,
      );
      const redeemedB = applySlippage(
        proportionalShare(toStroops('100'), toStroops('100'), toStroops('200')),
        0,
      );
      const basisA = toStroops('1000');
      const basisB = toStroops('100');
      expect(op.feeAmountA).toBe(
        fromStroops(computeFee(redeemedA - basisA, 50)),
      );
      expect(op.feeAmountB).toBe(
        fromStroops(computeFee(redeemedB - basisB, 50)),
      );
      expect(op.feeBps).toBe(50);
      expect(op.feeWallet).toBe(FEE_WALLET);
    });

    it('charges nothing on a withdraw with a loss (redeemed < basis)', async () => {
      seedCapturedDeposit();
      stellar.fetchPool.mockResolvedValue(
        poolRecord({
          total_shares: '100',
          reserves: [
            { asset: 'native', amount: '500' },
            { asset: `USDC:${USDC_ISSUER}`, amount: '50' },
          ],
        }),
      );
      const op = await service.withdraw(consumer, {
        source: SOURCE,
        poolId: POOL_ID,
        shares: '100',
        slippageBps: 0,
      });
      expect(op.feeAmountA).toBe('0');
      expect(op.feeAmountB).toBe('0');
    });

    it('returns 503 when planSwapFeeBps > 0, basis+gain produce a fee, and the fee wallet is unset', async () => {
      buildService('');
      seedCapturedDeposit();
      const err = await service
        .withdraw(consumer, {
          source: SOURCE,
          poolId: POOL_ID,
          shares: '100',
          slippageBps: 0,
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(err.getStatus()).toBe(503);
      expect(err.message).toMatch(/STELLAR_SWAP_FEE_WALLET is not set/);
    });
  });

  describe('costBasis', () => {
    it('ignores a SUCCEEDED deposit whose sharesReceived was never captured', async () => {
      prisma.rows.push(
        depositRow({
          status: 'SUCCEEDED',
          sharesReceived: null,
          settledAmountA: null,
          settledAmountB: null,
        }),
      );
      const basis = await (service as any).costBasis('c1', SOURCE, POOL_ID);
      expect(basis.depositedShares).toBe(0n);
      expect(basis.remainingShares).toBe(0n);
      expect(basis.costA).toBe(0n);
      expect(basis.costB).toBe(0n);
    });

    it('never returns a negative remainingShares', async () => {
      prisma.rows.push(
        depositRow({
          status: 'SUCCEEDED',
          sharesReceived: '40',
          settledAmountA: '400',
          settledAmountB: '40',
        }),
        depositRow({
          id: 'lp_w_over',
          kind: 'WITHDRAW',
          status: 'SUCCEEDED',
          shares: '100',
          amountA: '1000',
          amountB: '100',
        }),
      );
      const basis = await (service as any).costBasis('c1', SOURCE, POOL_ID);
      expect(basis.remainingShares).toBe(0n);
      expect(basis.remainingShares >= 0n).toBe(true);
    });

    it('does not charge commission twice on the same covered shares (200 on-chain, 100 with basis)', async () => {
      // Account holds 200 shares; only 100 were deposited through Cosmos Pay.
      // Two unsigned withdraws of 100 each, built before either settles.
      // Without discounting PENDING/SUBMITTED withdraws, both see
      // remainingShares = 100 and both tax the covered gain — i.e. the second
      // withdraw taxes shares that the doctrine says are taxed nothing.
      seedCapturedDeposit();
      stellar.loadAccount.mockResolvedValue(
        mockHorizonAccount([
          { asset_type: 'native', balance: '10000' },
          {
            asset_type: 'liquidity_pool_shares',
            liquidity_pool_id: POOL_ID,
            balance: '200',
          },
        ]),
      );
      stellar.fetchPool.mockResolvedValue(
        poolRecord({
          total_shares: '200',
          reserves: [
            { asset: 'native', amount: '4000' },
            { asset: `USDC:${USDC_ISSUER}`, amount: '400' },
          ],
        }),
      );

      const first = await service.withdraw(consumer, {
        source: SOURCE,
        poolId: POOL_ID,
        shares: '100',
        slippageBps: 0,
      });
      const second = await service.withdraw(consumer, {
        source: SOURCE,
        poolId: POOL_ID,
        shares: '100',
        slippageBps: 0,
      });

      // First withdraw covers the 100 shares with basis against doubled
      // reserves: redeemed 2000/200, basis 1000/100, 50 bps of the gain.
      expect(first.feeAmountA).not.toBe('0');
      expect(first.feeAmountB).not.toBe('0');
      expect(second.feeAmountA).toBe('0');
      expect(second.feeAmountB).toBe('0');
      expect(second.feeWallet).toBeNull();
    });

    it('does not double-charge when two withdraws of covered shares run concurrently', async () => {
      seedCapturedDeposit();
      stellar.loadAccount.mockResolvedValue(
        mockHorizonAccount([
          { asset_type: 'native', balance: '10000' },
          {
            asset_type: 'liquidity_pool_shares',
            liquidity_pool_id: POOL_ID,
            balance: '200',
          },
        ]),
      );
      stellar.fetchPool.mockResolvedValue(
        poolRecord({
          total_shares: '200',
          reserves: [
            { asset: 'native', amount: '4000' },
            { asset: `USDC:${USDC_ISSUER}`, amount: '400' },
          ],
        }),
      );

      const [a, b] = await Promise.all([
        service.withdraw(consumer, {
          source: SOURCE,
          poolId: POOL_ID,
          shares: '100',
          slippageBps: 0,
        }),
        service.withdraw(consumer, {
          source: SOURCE,
          poolId: POOL_ID,
          shares: '100',
          slippageBps: 0,
        }),
      ]);

      const fees = [a, b].map((op) => ({
        a: op.feeAmountA,
        b: op.feeAmountB,
      }));
      const charged = fees.filter((f) => f.a !== '0' || f.b !== '0');
      const free = fees.filter((f) => f.a === '0' && f.b === '0');
      expect(charged).toHaveLength(1);
      expect(free).toHaveLength(1);
    });

    it('takes a postgres advisory lock around costBasis and persist', async () => {
      seedCapturedDeposit();
      stellar.loadAccount.mockResolvedValue(
        mockHorizonAccount([
          { asset_type: 'native', balance: '10000' },
          {
            asset_type: 'liquidity_pool_shares',
            liquidity_pool_id: POOL_ID,
            balance: '200',
          },
        ]),
      );
      stellar.fetchPool.mockResolvedValue(
        poolRecord({
          total_shares: '200',
          reserves: [
            { asset: 'native', amount: '4000' },
            { asset: `USDC:${USDC_ISSUER}`, amount: '400' },
          ],
        }),
      );

      await service.withdraw(consumer, {
        source: SOURCE,
        poolId: POOL_ID,
        shares: '100',
        slippageBps: 0,
      });

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.$executeRaw).toHaveBeenCalled();
      const sql = String(prisma.$executeRaw.mock.calls[0][0]);
      expect(sql).toContain('pg_advisory_xact_lock');
    });

    it('emits LIQUIDITY_CREATED and builds the QR after the withdraw transaction commits', async () => {
      seedCapturedDeposit();
      stellar.loadAccount.mockResolvedValue(
        mockHorizonAccount([
          { asset_type: 'native', balance: '10000' },
          {
            asset_type: 'liquidity_pool_shares',
            liquidity_pool_id: POOL_ID,
            balance: '200',
          },
        ]),
      );
      stellar.fetchPool.mockResolvedValue(
        poolRecord({
          total_shares: '200',
          reserves: [
            { asset: 'native', amount: '4000' },
            { asset: `USDC:${USDC_ISSUER}`, amount: '400' },
          ],
        }),
      );

      const order: string[] = [];
      prisma.$transaction.mockImplementation(async (arg: any) => {
        if (typeof arg !== 'function') return Promise.all(arg);
        const result = await arg({
          $executeRaw: prisma.$executeRaw,
          liquidityPoolOperation: prisma.liquidityPoolOperation,
        });
        order.push('commit');
        return result;
      });
      events.emit.mockImplementation(() => {
        order.push('emit');
        return false;
      });
      const qr = jest.requireMock('qrcode').default.toDataURL as jest.Mock;
      qr.mockImplementation(async () => {
        order.push('qr');
        return 'data:image/png;base64,qq';
      });

      try {
        const op = await service.withdraw(consumer, {
          source: SOURCE,
          poolId: POOL_ID,
          shares: '100',
          slippageBps: 0,
        });
        expect(op.qr).toBe('data:image/png;base64,qq');
        expect(order).toEqual(['commit', 'emit', 'qr']);
      } finally {
        qr.mockResolvedValue('data:image/png;base64,qq');
      }
    });

    it('documents that an uncaptured deposit plus a later withdraw erodes remainingShares of other deposits (issue #20b)', async () => {
      // Horizon hiccup → captureDepositBasis leaves sharesReceived null.
      // costBasis skips that deposit, but a later SUCCEEDED withdraw still
      // subtracts shares. Observer never retries SUCCEEDED rows, so the
      // captured deposit's remainingShares collapses and is not self-healing.
      prisma.rows.push(
        depositRow({
          id: 'lp_captured',
          status: 'SUCCEEDED',
          sharesReceived: '100',
          settledAmountA: '1000',
          settledAmountB: '100',
        }),
        depositRow({
          id: 'lp_lost',
          status: 'SUCCEEDED',
          sharesReceived: null,
          settledAmountA: null,
          settledAmountB: null,
        }),
        depositRow({
          id: 'lp_w_erode',
          kind: 'WITHDRAW',
          status: 'SUCCEEDED',
          shares: '100',
          amountA: '1000',
          amountB: '100',
        }),
      );
      const basis = await (service as any).costBasis('c1', SOURCE, POOL_ID);
      expect(basis.depositedShares).toBe(toStroops('100'));
      expect(basis.remainingShares).toBe(0n);
    });

    it('does not treat a FAILED withdraw as consuming remainingShares', async () => {
      seedCapturedDeposit();
      prisma.rows.push(
        depositRow({
          id: 'lp_w_failed',
          kind: 'WITHDRAW',
          status: 'FAILED',
          shares: '100',
          amountA: '1000',
          amountB: '100',
        }),
      );
      const basis = await (service as any).costBasis('c1', SOURCE, POOL_ID);
      expect(basis.remainingShares).toBe(toStroops('100'));
    });
  });

  describe('assertCanAfford (via deposit)', () => {
    it('returns 400 when XLM is just below the minimum reserve', async () => {
      // subentry_count 1, existing pool trust → reserve (2+1)*0.5 = 1.5 XLM;
      // 1 op × 100 stroops fee. Depositing 1 XLM needs 2.50001; holding 2.5.
      stellar.loadAccount.mockResolvedValue(
        depositAccount({
          hasPoolShare: true,
          native: '2.5',
          usdc: '10000',
        }),
      );
      stellar.fetchPool.mockResolvedValue(
        poolRecord({ id: nativeUsdcPoolId() }),
      );
      const err = await service
        .deposit(consumer, {
          source: SOURCE,
          assetACode: 'XLM',
          assetBCode: 'USDC',
          assetBIssuer: USDC_ISSUER,
          maxAmountA: '1',
          maxAmountB: '1',
          slippageBps: 0,
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getStatus()).toBe(400);
      expect(err.message).toMatch(/Insufficient XLM balance/);
      expect(err.message).toMatch(/1\.50001 XLM reserve \+ network fee/);
      expect(err.message).toMatch(/holds 2\.5 XLM/);
    });

    it('returns 400 when the issued-asset trustline cannot cover the deposit', async () => {
      stellar.loadAccount.mockResolvedValue(
        depositAccount({
          hasPoolShare: true,
          native: '10000',
          usdc: '4',
        }),
      );
      stellar.fetchPool.mockResolvedValue(
        poolRecord({ id: nativeUsdcPoolId() }),
      );
      const err = await service
        .deposit(consumer, {
          source: SOURCE,
          assetACode: 'XLM',
          assetBCode: 'USDC',
          assetBIssuer: USDC_ISSUER,
          maxAmountA: '50',
          maxAmountB: '5',
          slippageBps: 0,
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getStatus()).toBe(400);
      expect(err.message).toMatch(
        /Insufficient USDC balance: need 5, but the account holds 4/,
      );
    });
  });

  describe('positions', () => {
    it('returns the resolvable positions when one pool fetch fails, instead of 503', async () => {
      stellar.loadAccount.mockResolvedValue(
        mockHorizonAccount([
          { asset_type: 'native', balance: '10000' },
          {
            asset_type: 'liquidity_pool_shares',
            liquidity_pool_id: POOL_OK_1,
            balance: '10',
          },
          {
            asset_type: 'liquidity_pool_shares',
            liquidity_pool_id: POOL_FAIL,
            balance: '20',
          },
          {
            asset_type: 'liquidity_pool_shares',
            liquidity_pool_id: POOL_OK_2,
            balance: '30',
          },
        ]),
      );
      stellar.fetchPool.mockImplementation((id: string) => {
        if (id === POOL_FAIL) {
          return Promise.reject(
            Object.assign(new Error('Horizon 500'), {
              response: { status: 500 },
            }),
          );
        }
        return Promise.resolve(
          poolRecord({
            id,
            total_shares: '1000',
            reserves: [
              { asset: 'native', amount: '5000' },
              { asset: `USDC:${USDC_ISSUER}`, amount: '500' },
            ],
          }),
        );
      });

      const result = await service.positions(consumer, { account: SOURCE });
      expect(result.account).toBe(SOURCE);
      expect(result.data).toHaveLength(2);
      expect(result.data.map((p) => p.poolId).sort()).toEqual(
        [POOL_OK_1, POOL_OK_2].sort(),
      );
    });

    it('returns 503 when every pool fetch fails (Horizon outage)', async () => {
      stellar.loadAccount.mockResolvedValue(
        mockHorizonAccount([
          { asset_type: 'native', balance: '10000' },
          {
            asset_type: 'liquidity_pool_shares',
            liquidity_pool_id: POOL_OK_1,
            balance: '10',
          },
          {
            asset_type: 'liquidity_pool_shares',
            liquidity_pool_id: POOL_OK_2,
            balance: '30',
          },
        ]),
      );
      stellar.fetchPool.mockImplementation(() =>
        Promise.reject(
          Object.assign(new Error('Horizon 500'), {
            response: { status: 500 },
          }),
        ),
      );

      const err = await service
        .positions(consumer, { account: SOURCE })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(err.getStatus()).toBe(503);
    });
  });
});
