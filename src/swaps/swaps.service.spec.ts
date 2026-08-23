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

function matchesWhere(row: any, where: any): boolean {
  if (!where) return true;
  if (where.id && where.id !== row.id) return false;
  if (where.consumerId && where.consumerId !== row.consumerId) return false;
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
        for (const row of matched) Object.assign(row, data);
        return { count: matched.length };
      }),
    },
    webhookEmittedEvent: uniqueEmittedEvents(),
  };
  return prisma;
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

function makeStellar() {
  const submitTransaction = jest.fn().mockResolvedValue({ hash: TX_HASH });
  const txCall = jest.fn().mockResolvedValue({ successful: true });
  const account: any = new Account(SOURCE, '1');
  account.balances = [{ asset_type: 'native', balance: '10000' }];
  return {
    passphrase: jest.fn().mockReturnValue('Test SDF Network ; September 2015'),
    server: jest.fn().mockReturnValue({
      submitTransaction,
      transactions: () => ({ transaction: () => ({ call: txCall }) }),
      loadAccount: jest.fn().mockResolvedValue(account),
    }),
    submitTransaction,
    txCall,
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
    destAssetIssuer: Keypair.random().publicKey(),
    destEstimated: '9',
    destMin: '8.9',
    slippageBps: 50,
    path: [],
    memo: null,
    xdr: 'AAAA',
    uri: 'web+stellar:tx?xdr=AAAA',
    txHash: TX_HASH,
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
});
