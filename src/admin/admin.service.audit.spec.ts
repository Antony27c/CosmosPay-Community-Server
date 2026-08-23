import { NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';

describe('AdminService.setReceiverAccess (atomic audit)', () => {
  it('rolls back the mutation when the audit insert fails', async () => {
    let disabled = false;
    const tx = {
      blindpayReceiver: {
        findUnique: jest.fn(async () => ({ id: 'rcv_1', disabled: false })),
        update: jest.fn(async ({ data }: any) => {
          disabled = data.disabled;
          return { id: 'rcv_1', disabled, consumer: null };
        }),
      },
      adminAuditLog: {
        create: jest.fn(async () => {
          throw new Error('audit write failed');
        }),
      },
    };

    const prisma = {
      $transaction: jest.fn(async (fn: any) => {
        try {
          return await fn(tx);
        } catch (err) {
          // Simulate rollback of the in-memory mutation.
          disabled = false;
          throw err;
        }
      }),
    };

    const service = new AdminService(prisma as any, {} as any);

    await expect(
      service.setReceiverAccess('rcv_1', true, {
        id: 'owner',
        role: 'write',
      }),
    ).rejects.toThrow('audit write failed');

    expect(disabled).toBe(false);
    expect(tx.adminAuditLog.create).toHaveBeenCalled();
    expect(tx.blindpayReceiver.update).toHaveBeenCalled();
  });

  it('commits mutation and audit together on success', async () => {
    const created: any[] = [];
    const tx = {
      blindpayReceiver: {
        findUnique: jest.fn(async () => ({ id: 'rcv_1', disabled: false })),
        update: jest.fn(async ({ data }: any) => ({
          id: 'rcv_1',
          disabled: data.disabled,
          consumer: null,
        })),
      },
      adminAuditLog: {
        create: jest.fn(async ({ data }: any) => {
          created.push(data);
          return data;
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const service = new AdminService(prisma as any, {} as any);

    const result = await service.setReceiverAccess('rcv_1', true, {
      id: 'owner',
      role: 'write',
    });

    expect(result.disabled).toBe(true);
    expect(created).toEqual([
      expect.objectContaining({
        actorId: 'owner',
        action: 'receivers.setAccess',
        resourceId: 'rcv_1',
      }),
    ]);
  });

  it('throws NotFound without writing audit when the receiver is missing', async () => {
    const tx = {
      blindpayReceiver: {
        findUnique: jest.fn(async () => null),
        update: jest.fn(),
      },
      adminAuditLog: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const service = new AdminService(prisma as any, {} as any);

    await expect(
      service.setReceiverAccess('missing', true, {
        id: 'owner',
        role: 'write',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.adminAuditLog.create).not.toHaveBeenCalled();
  });
});
