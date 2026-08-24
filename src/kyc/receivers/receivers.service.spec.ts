import { ConflictException } from '@nestjs/common';
import { ReceiversService } from './receivers.service';
import {
  ALLOWED_TRANSITIONS,
  assertTransition,
} from './receiver-state';

const CONSUMER = { username: 'cosmos_u1' } as any;
const LOCAL_ID = 'local_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const REAL_ID = 're_000000000000';

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rcv_1',
    consumerId: 'c1',
    blindpayId: LOCAL_ID,
    type: 'individual',
    kycType: 'standard',
    kycStatus: 'inactive',
    email: 'jane@acme.com',
    name: null,
    country: 'US',
    externalId: null,
    disabled: false,
    tosSentAt: null,
    raw: {
      type: 'individual',
      kyc_type: 'standard',
      email: 'jane@acme.com',
      country: 'US',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeService() {
  const prisma: any = {
    blindpayReceiver: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      findMany: jest.fn(),
    },
    consumer: {
      findUnique: jest.fn().mockResolvedValue({
        apisixUsername: 'cosmos_u1',
      }),
    },
    $transaction: jest.fn(async (fn: any) => {
      if (typeof fn === 'function') {
        return fn(prisma);
      }
      return Promise.all(fn);
    }),
  };
  const blindpay = {
    put: jest.fn(),
    post: jest.fn(),
    get: jest.fn(),
    delete: jest.fn(),
    instanceId: 'in_test',
    instancePath: jest.fn((p: string) => `/instances/in_test${p}`),
  };
  const consumers = {
    resolve: jest.fn().mockResolvedValue({ id: 'c1' }),
  };
  const sync = {
    mirrorReceiver: jest.fn(),
  };
  const config = {
    get: jest.fn().mockReturnValue({
      redirectUrlWhitelist: { cosmos_u1: ['app.example.com'] },
    }),
  };
  const service = new ReceiversService(
    prisma as any,
    blindpay as any,
    consumers as any,
    sync as any,
    config as any,
  );
  return { service, prisma, blindpay, consumers, sync, config };
}

describe('receiver-state assertTransition', () => {
  it('allows every declared edge in ALLOWED_TRANSITIONS', () => {
    for (const [from, tos] of Object.entries(ALLOWED_TRANSITIONS)) {
      for (const to of tos) {
        expect(() => assertTransition(from, to as any)).not.toThrow();
      }
    }
  });

  it('rejects inactive → pending_user with 409 naming both states', () => {
    expect(() => assertTransition('inactive', 'pending_user')).toThrow(
      ConflictException,
    );
    try {
      assertTransition('inactive', 'pending_user');
    } catch (err) {
      expect((err as ConflictException).message).toBe(
        "Cannot move receiver from 'inactive' to 'pending_user'",
      );
    }
  });

  it('rejects pending_user → pending_review with 409', () => {
    expect(() => assertTransition('pending_user', 'pending_review')).toThrow(
      ConflictException,
    );
    try {
      assertTransition('pending_user', 'pending_review');
    } catch (err) {
      expect((err as ConflictException).message).toContain('pending_user');
      expect((err as ConflictException).message).toContain('pending_review');
    }
  });
});

describe('ReceiversService.update — local branch', () => {
  it('does not call BlindpayClient.put for a local_ blindpayId', async () => {
    const { service, prisma, blindpay } = makeService();
    const row = baseRow({ kycStatus: 'inactive' });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    prisma.blindpayReceiver.update.mockImplementation(
      async ({ data }: any) => ({ ...row, ...data }),
    );

    await service.update(CONSUMER, row.id, { email: 'new@acme.com' } as any);

    expect(blindpay.put).not.toHaveBeenCalled();
    expect(prisma.blindpayReceiver.update).toHaveBeenCalled();
  });

  it('promotes inactive → pending_review when the merged payload has KYC data', async () => {
    const { service, prisma, blindpay } = makeService();
    const row = baseRow({ kycStatus: 'inactive' });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    prisma.blindpayReceiver.update.mockImplementation(
      async ({ data }: any) => ({ ...row, ...data }),
    );

    const result = await service.update(CONSUMER, row.id, {
      tax_id: '123-45-6789',
    } as any);

    expect(blindpay.put).not.toHaveBeenCalled();
    expect(result.kycStatus).toBe('pending_review');
    expect(prisma.blindpayReceiver.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kycStatus: 'pending_review' }),
      }),
    );
  });

  it('keeps inactive when the patch does not satisfy hasKycData', async () => {
    const { service, prisma, blindpay } = makeService();
    const row = baseRow({ kycStatus: 'inactive' });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    prisma.blindpayReceiver.update.mockImplementation(
      async ({ data }: any) => ({ ...row, ...data }),
    );

    const result = await service.update(CONSUMER, row.id, {
      email: 'only-email@acme.com',
    } as any);

    expect(blindpay.put).not.toHaveBeenCalled();
    expect(result.kycStatus).toBe('inactive');
    expect(prisma.blindpayReceiver.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kycStatus: 'inactive' }),
      }),
    );
  });

  it('merges the patch onto raw and preserves untouched keys', async () => {
    const { service, prisma } = makeService();
    const row = baseRow({
      kycStatus: 'pending_review',
      raw: { type: 'individual', country: 'US' },
    });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    let savedRaw: Record<string, unknown> | undefined;
    prisma.blindpayReceiver.update.mockImplementation(async ({ data }: any) => {
      savedRaw = data.raw as Record<string, unknown>;
      return { ...row, ...data };
    });

    await service.update(CONSUMER, row.id, { tax_id: '99-9999999' } as any);

    expect(savedRaw).toEqual({
      type: 'individual',
      country: 'US',
      tax_id: '99-9999999',
    });
  });

  it('strips tos_id from the local patch so it cannot be forged', async () => {
    const { service, prisma } = makeService();
    const row = baseRow({
      kycStatus: 'pending_user',
      raw: { type: 'individual', country: 'US', email: 'jane@acme.com' },
    });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    let savedRaw: Record<string, unknown> | undefined;
    prisma.blindpayReceiver.update.mockImplementation(async ({ data }: any) => {
      savedRaw = data.raw as Record<string, unknown>;
      return { ...row, ...data };
    });

    await service.update(CONSUMER, row.id, {
      tax_id: '111',
      tos_id: 'tos_forged',
    } as any);

    expect(savedRaw).not.toHaveProperty('tos_id');
    expect(savedRaw?.tax_id).toBe('111');
  });
});

describe('ReceiversService.update — remote branch', () => {
  it('PUTs to BlindPay and mirrors when blindpayId is a real re_ id', async () => {
    const { service, prisma, blindpay, sync } = makeService();
    const row = baseRow({
      blindpayId: REAL_ID,
      kycStatus: 'verifying',
    });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    blindpay.put.mockResolvedValue({ email: 'updated@acme.com' });
    const mirrored = { ...row, email: 'updated@acme.com' };
    sync.mirrorReceiver.mockResolvedValue(mirrored);

    const result = await service.update(CONSUMER, row.id, {
      email: 'updated@acme.com',
      tos_id: 'tos_forged',
    } as any);

    expect(blindpay.put).toHaveBeenCalledWith(
      '/instances/in_test/customers/re_000000000000',
      { email: 'updated@acme.com' },
    );
    expect(sync.mirrorReceiver).toHaveBeenCalledWith('c1', {
      id: REAL_ID,
      email: 'updated@acme.com',
    });
    expect(result).toBe(mirrored);
  });
});

describe('ReceiversService.approve — transitions', () => {
  it('pending_review → pending_user succeeds', async () => {
    const { service, prisma, blindpay } = makeService();
    const row = baseRow({ kycStatus: 'pending_review' });
    prisma.blindpayReceiver.findUnique.mockResolvedValue(row);
    blindpay.post.mockResolvedValue({ url: 'https://tos.example/accept' });
    prisma.blindpayReceiver.update.mockImplementation(
      async ({ data }: any) => ({ ...row, ...data }),
    );

    const result = await service.approveById(
      row.id,
      'https://app.example.com/cb',
    );

    expect(result.receiver.kycStatus).toBe('pending_user');
    expect(result.url).toBe('https://tos.example/accept');
  });

  it('inactive → pending_user returns 409 naming both states', async () => {
    const { service, prisma } = makeService();
    prisma.blindpayReceiver.findUnique.mockResolvedValue(
      baseRow({ kycStatus: 'inactive' }),
    );

    await expect(
      service.approveById('rcv_1', 'https://app.example.com/cb'),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.approveById('rcv_1', 'https://app.example.com/cb'),
    ).rejects.toThrow("Cannot move receiver from 'inactive' to 'pending_user'");
  });
});

describe('ReceiversService.enable — transitions', () => {
  it('pending_user → verifying (active) via enable succeeds', async () => {
    const { service, prisma, blindpay, sync } = makeService();
    const row = baseRow({
      kycStatus: 'pending_user',
      raw: {
        type: 'individual',
        kyc_type: 'standard',
        email: 'jane@acme.com',
        country: 'US',
        tax_id: '123-45-6789',
      },
    });
    prisma.blindpayReceiver.findUnique.mockResolvedValue(row);
    const created = {
      id: REAL_ID,
      kyc_status: 'verifying',
      type: 'individual',
      email: 'jane@acme.com',
    };
    blindpay.post.mockResolvedValue(created);
    prisma.blindpayReceiver.update.mockResolvedValue({
      ...row,
      blindpayId: REAL_ID,
    });
    const mirrored = {
      ...row,
      blindpayId: REAL_ID,
      kycStatus: 'verifying',
    };
    sync.mirrorReceiver.mockResolvedValue(mirrored);

    const result = await service.enableById(row.id, 'tos_abc');

    expect(blindpay.post).toHaveBeenCalledWith(
      '/instances/in_test/customers',
      expect.objectContaining({ tos_id: 'tos_abc' }),
    );
    expect(sync.mirrorReceiver).toHaveBeenCalledWith('c1', created);
    expect(result.kycStatus).toBe('verifying');
    expect(result.blindpayId).toBe(REAL_ID);
  });

  it('inactive → verifying via enable returns 409', async () => {
    const { service, prisma, blindpay } = makeService();
    prisma.blindpayReceiver.findUnique.mockResolvedValue(
      baseRow({ kycStatus: 'inactive' }),
    );

    await expect(service.enableById('rcv_1', 'tos_abc')).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.enableById('rcv_1', 'tos_abc')).rejects.toThrow(
      "Cannot move receiver from 'inactive' to 'verifying'",
    );
    expect(blindpay.post).not.toHaveBeenCalled();
  });

  it('pending_review → verifying via enable returns 409', async () => {
    const { service, prisma, blindpay } = makeService();
    prisma.blindpayReceiver.findUnique.mockResolvedValue(
      baseRow({ kycStatus: 'pending_review' }),
    );

    await expect(service.enableById('rcv_1', 'tos_abc')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(blindpay.post).not.toHaveBeenCalled();
  });
});
