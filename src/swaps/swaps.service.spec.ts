import { ConflictException } from '@nestjs/common';
import { Account, Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { SettlementObserverService } from '../observer/settlement-observer.service';
import { WEBHOOK_EVENT } from '../webhooks/webhook-events';
import { WebhookTerminalEmitter } from '../webhooks/webhook-terminal-emitter.service';
import { SwapsService } from './swaps.service';

jest.mock('qrcode', () => ({
  __esModule: true,
  default: {
    toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,qq'),
  },
}));

const TX_HASH = 'ab'.repeat(32);
const SOURCE = Keypair.random().publicKey();
const FEE_WALLET = Keypair.random().publicKey();
const DEST_ISSUER = Keypair.random().publicKey();

const consumer: GatewayConsumer = {
  username: 'cosmos_u1',
  credentialId: 'cred_1',
  environment: 'dev',
  role: 'user',
  permissions: ['swaps:write'],
  organizationId: 'org_1',
  plan: 'pro',
  planSwapFeeBps: 50,
};

function horizonReject(codes: { transaction?: string; operations?: string[] }) {
  const err: any = new Error('Horizon rejected the transaction');
  err.response = { data: { extras: { result_codes: codes } } };
  return err;
}

function applyUpdateData(row: any, data: any): void {
  const next = { ...data };
  if (next.settlementEpoch?.increment != null) {
    row.settlementEpoch =
      (row.settlementEpoch ?? 0) + next.settlementEpoch.increment;
    delete next.settlementEpoch;
  }
  Object.assign(row, next);
}

function matchesWhere(row: any, where: any): boolean {
  if (!where) return true;
  if (where.id && where.id !== row.id) return false;
  if (where.consumerId && where.consumerId !== row.consumerId) return false;
  if (where.source && where.source !== row.source) return false;
  if (where.network && where.network !== row.network) return false;
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

function createPrisma(seed: any[] = []) {
  const rows = seed.map((r) => ({ ...r }));
  const prisma: any = {
    rows,
    consumer: {
      upsert: jest.fn(async ({ where, create }: any) => ({
        id: 'c1',
        apisixUsername: where.apisixUsername,
        ...create,
      })),
    },
    swap: {
      findMany: jest.fn(async ({ where, include }: any) =>
        rows
          .filter((r) => matchesWhere(r, where))
          .map((r) => {
            const copy = { ...r };
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
        if (where.consumerId_idempotencyKey) {
          const { consumerId, idempotencyKey } =
            where.consumerId_idempotencyKey;
          const row = rows.find(
            (r) =>
              r.consumerId === consumerId &&
              r.idempotencyKey === idempotencyKey,
          );
          return row ? { ...row } : null;
        }
        const row = rows.find((r) => r.id === where.id);
        return row ? { ...row } : null;
      }),
      create: jest.fn(async ({ data }: any) => {
        if (data.idempotencyKey) {
          const clash = rows.find(
            (r) =>
              r.consumerId === data.consumerId &&
              r.idempotencyKey === data.idempotencyKey,
          );
          if (clash) {
            const err: any = new Error('Unique constraint failed');
            err.code = 'P2002';
            err.meta = { target: ['consumerId', 'idempotencyKey'] };
            throw err;
          }
        }
        const hashClash = rows.find(
          (r) => r.network === data.network && r.txHash === data.txHash,
        );
        if (hashClash) {
          const err: any = new Error('Unique constraint failed');
          err.code = 'P2002';
          err.meta = { target: ['network', 'txHash'] };
          throw err;
        }
        const row = {
          id: `swap_${rows.length + 1}`,
          settlementEpoch: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const matched = rows.filter((r) => matchesWhere(r, where));
        for (const row of matched) applyUpdateData(row, data);
        return { count: matched.length };
      }),
    },
    webhookEmittedEvent: uniqueEmittedEvents(),
  };
  return prisma;
}

function stellarConfig(swapOverrides: Record<string, unknown> = {}) {
  return {
    network: 'testnet',
    baseFee: '100',
    timeoutSeconds: 300,
    swap: {
      feeWallet: FEE_WALLET,
      feeBps: 50,
      slippageBps: 50,
      maxSlippageBps: 500,
      singleInflight: false,
      ...swapOverrides,
    },
    horizon: { public: 'https://h', testnet: 'https://h' },
  };
}

function makeStellar() {
  const submitTransaction = jest.fn().mockResolvedValue({ hash: TX_HASH });
  const txCall = jest.fn().mockResolvedValue({ successful: true });
  const balances = [
    { asset_type: 'native', balance: '10000' },
    {
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: DEST_ISSUER,
      balance: '0',
    },
  ];
  const strictSendPaths = jest.fn().mockReturnValue({
    call: jest.fn().mockResolvedValue({
      records: [{ destination_amount: '9.5', path: [] }],
    }),
  });
  const loadAccount = jest.fn().mockImplementation(async () => {
    // Fresh Account each call so sequence stays at Horizon's view (N), not N+k
    // after a prior TransactionBuilder mutation — needed for txHash-collision tests.
    const account: any = new Account(SOURCE, '1');
    account.balances = balances;
    return account;
  });
  return {
    passphrase: jest.fn().mockReturnValue('Test SDF Network ; September 2015'),
    server: jest.fn().mockReturnValue({
      submitTransaction,
      transactions: () => ({ transaction: () => ({ call: txCall }) }),
      loadAccount,
      strictSendPaths,
    }),
    submitTransaction,
    txCall,
    strictSendPaths,
    loadAccount,
  };
}

function swapRow(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'swap_1',
    consumerId: 'c1',
    status: 'PENDING',
    network: 'testnet',
    source: SOURCE,
    destination: SOURCE,
    sendAsset: 'native',
    sendAssetIssuer: null,
    sendAmount: '10',
    feeAmount: '0',
    feeBps: 0,
    swapAmount: '10',
    destAsset: 'USDC',
    destAssetIssuer: DEST_ISSUER,
    destEstimated: '9',
    destMin: '8.9',
    slippageBps: 50,
    path: [],
    memo: null,
    idempotencyKey: null,
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

function terminalEmits(events: EventEmitter2, type: string) {
  return (events.emit as unknown as jest.Mock).mock.calls.filter(
    ([name, payload]) => name === WEBHOOK_EVENT && payload.type === type,
  );
}

describe('SwapsService.submit vs observer (issue #29 double terminal event)', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let stellar: ReturnType<typeof makeStellar>;
  let events: EventEmitter2;
  let service: SwapsService;
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
    service = new SwapsService(config, prisma as any, webhooks, stellar as any);
    observer = new SettlementObserverService(
      config,
      prisma as any,
      stellar as any,
      {} as any,
      service,
    );
    jest
      .spyOn(TransactionBuilder, 'fromXDR')
      .mockReturnValue({ hash: () => Buffer.from(TX_HASH, 'hex') } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('observer and submit in parallel emit SWAP_SUCCEEDED once (used to emit twice)', async () => {
    const row = swapRow({ status: 'PENDING' });
    prisma.rows.push(row);
    stellar.txCall.mockResolvedValue({ successful: true });
    stellar.submitTransaction.mockResolvedValue({ hash: TX_HASH });

    await Promise.all([
      service.submit(consumer, row.id, 'signed-xdr'),
      (observer as any).reconcileSwaps(50),
    ]);

    expect(row.status).toBe('SUCCEEDED');
    expect(terminalEmits(events, 'SWAP_SUCCEEDED')).toHaveLength(1);
  });

  it('does not emit SWAP_FAILED when the observer already won SUCCEEDED during submit', async () => {
    const row = swapRow({ status: 'PENDING' });
    prisma.rows.push(row);

    stellar.submitTransaction.mockImplementation(async () => {
      stellar.txCall.mockResolvedValue({ successful: true });
      await (observer as any).reconcileSwaps(50);
      throw horizonReject({ transaction: 'tx_already_included' });
    });

    const outcome = await service.submit(consumer, row.id, 'signed-xdr');

    expect(outcome.status).toBe('SUCCEEDED');
    expect(row.status).toBe('SUCCEEDED');
    expect(terminalEmits(events, 'SWAP_SUCCEEDED')).toHaveLength(1);
    expect(terminalEmits(events, 'SWAP_FAILED')).toHaveLength(0);
  });

  it('finalizeFailed is a no-op on SUCCEEDED and never emits SWAP_FAILED', async () => {
    const row = swapRow({ status: 'SUCCEEDED' });
    prisma.rows.push(row);

    const result = await service.finalizeFailed(row.id, consumer.username);

    expect(result.applied).toBe(false);
    expect(result.swap.status).toBe('SUCCEEDED');
    expect(row.status).toBe('SUCCEEDED');
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('two concurrent finalizeSucceeded calls emit SWAP_SUCCEEDED once', async () => {
    const row = swapRow({ status: 'PENDING' });
    prisma.rows.push(row);

    const [a, b] = await Promise.all([
      service.finalizeSucceeded(row.id, consumer.username, TX_HASH),
      service.finalizeSucceeded(row.id, consumer.username, TX_HASH),
    ]);

    expect([a.applied, b.applied].filter(Boolean)).toHaveLength(1);
    expect(terminalEmits(events, 'SWAP_SUCCEEDED')).toHaveLength(1);
  });

  it('emits SWAP_FAILED again after a valid resubmit from FAILED', async () => {
    const row = swapRow({ status: 'PENDING' });
    prisma.rows.push(row);

    await service.finalizeFailed(row.id, consumer.username);
    expect(row.status).toBe('FAILED');
    expect(terminalEmits(events, 'SWAP_FAILED')).toHaveLength(1);

    stellar.submitTransaction.mockRejectedValue(
      horizonReject({ transaction: 'tx_bad_auth' }),
    );
    const outcome = await service.submit(consumer, row.id, 'signed-xdr');

    expect(outcome.status).toBe('FAILED');
    expect(row.status).toBe('FAILED');
    expect(row.settlementEpoch).toBe(1);
    expect(terminalEmits(events, 'SWAP_FAILED')).toHaveLength(2);
  });
});

const createDto = {
  source: SOURCE,
  amount: '10',
  destAssetCode: 'USDC',
  destAssetIssuer: DEST_ISSUER,
};

describe('SwapsService.create idempotency (issue #17)', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let stellar: ReturnType<typeof makeStellar>;
  let events: EventEmitter2;
  let service: SwapsService;

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
    service = new SwapsService(config, prisma as any, webhooks, stellar as any);
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('two create() calls with the same Idempotency-Key hit prisma.swap.create once and return the same id', async () => {
    const first = await service.create(consumer, createDto, 'key-1');
    const second = await service.create(consumer, createDto, 'key-1');

    expect(prisma.swap.create).toHaveBeenCalledTimes(1);
    expect(second.id).toBe(first.id);
    expect(second.txHash).toBe(first.txHash);
    expect(prisma.rows).toHaveLength(1);
    // Only one SWAP_CREATED (second is a pure read).
    expect(terminalEmits(events, 'SWAP_CREATED')).toHaveLength(1);
  });

  it('translates an idempotency-key P2002 into the existing row (no P2002 to the client)', async () => {
    const existing = swapRow({
      id: 'swap_existing',
      idempotencyKey: 'race-key',
      txHash: 'cd'.repeat(32),
    });
    let idempotencyLookups = 0;
    prisma.swap.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.consumerId_idempotencyKey) {
        idempotencyLookups += 1;
        // First lookup misses (race window); after create fails, return winner.
        return idempotencyLookups === 1 ? null : { ...existing };
      }
      const row = prisma.rows.find((r: any) => r.id === where.id);
      return row ? { ...row } : null;
    });
    prisma.swap.create.mockRejectedValue({
      code: 'P2002',
      meta: { target: ['consumerId', 'idempotencyKey'] },
    });

    const result = await service.create(consumer, createDto, 'race-key');

    expect(result.id).toBe('swap_existing');
    expect(result.txHash).toBe(existing.txHash);
  });

  it('recovers via Idempotency-Key even when Postgres reports the txHash target', async () => {
    // Same-key concurrent creates rebuild the same XDR → both unique indexes
    // can fire; Postgres may report only (network, txHash). Must still return
    // the existing swap, not 409.
    const existing = swapRow({
      id: 'swap_winner',
      idempotencyKey: 'same-key',
      txHash: 'ef'.repeat(32),
    });
    let idempotencyLookups = 0;
    prisma.swap.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.consumerId_idempotencyKey) {
        idempotencyLookups += 1;
        return idempotencyLookups === 1 ? null : { ...existing };
      }
      return null;
    });
    prisma.swap.create.mockRejectedValue({
      code: 'P2002',
      meta: { target: ['network', 'txHash'] },
    });

    const result = await service.create(consumer, createDto, 'same-key');

    expect(result.id).toBe('swap_winner');
    expect(result.txHash).toBe(existing.txHash);
  });

  it('maps a (network, txHash) unique violation to a clear ConflictException', async () => {
    await service.create(consumer, createDto);
    expect(prisma.rows).toHaveLength(1);

    // Same frozen clock + same quote → identical XDR/hash → unique (network, txHash).
    await expect(service.create(consumer, createDto)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.create(consumer, createDto)).rejects.toThrow(
      /transaction hash/i,
    );
    expect(prisma.rows).toHaveLength(1);
  });

  it('returns 409 when STELLAR_SWAP_SINGLE_INFLIGHT blocks a second PENDING source', async () => {
    const config = {
      get: (key?: string) =>
        key === 'observer'
          ? { enabled: false, intervalMs: 15_000, batchSize: 50 }
          : stellarConfig({ singleInflight: true }),
    } as any;
    const webhooks = new WebhookTerminalEmitter(prisma as any, events);
    service = new SwapsService(config, prisma as any, webhooks, stellar as any);

    await service.create(consumer, createDto, 'a');
    await expect(
      service.create(consumer, createDto, 'b'),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(service.create(consumer, createDto, 'b')).rejects.toThrow(
      /in-flight swap already exists/i,
    );
  });
});

describe('SettlementObserverService duplicate txHash (issue #17)', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let stellar: ReturnType<typeof makeStellar>;
  let events: EventEmitter2;
  let service: SwapsService;
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
    service = new SwapsService(config, prisma as any, webhooks, stellar as any);
    observer = new SettlementObserverService(
      config,
      prisma as any,
      stellar as any,
      {} as any,
      service,
    );
  });

  it('two PENDING swaps with the same txHash emit a single SWAP_SUCCEEDED', async () => {
    const a = swapRow({ id: 'swap_a', status: 'PENDING', txHash: TX_HASH });
    const b = swapRow({ id: 'swap_b', status: 'PENDING', txHash: TX_HASH });
    prisma.rows.push(a, b);
    stellar.txCall.mockResolvedValue({ successful: true });

    await (observer as any).reconcileSwaps(50);

    expect(a.status).toBe('SUCCEEDED');
    expect(b.status).toBe('SUCCEEDED');
    expect(terminalEmits(events, 'SWAP_SUCCEEDED')).toHaveLength(1);
    // One Horizon lookup for the shared hash, not one per row.
    expect(stellar.txCall).toHaveBeenCalledTimes(1);
  });
});
