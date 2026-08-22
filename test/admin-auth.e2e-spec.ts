import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AdminService } from '../src/admin/admin.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue #34 — platform-admin auth + audit.
 *
 * For every mutating admin endpoint:
 *   - no admin credential → 401
 *   - read-only credential → 403
 *   - write credential → 2xx + audit row
 *
 * Also proves the legacy plaintext `X-Cosmos-Admin: 1` marker no longer grants access,
 * and that audit logs are consultable with no DELETE route.
 */
describe('Admin auth & audit (e2e) — issue #34', () => {
  let app: INestApplication;
  const auditRows: any[] = [];

  const adminServiceMock = {
    summary: jest.fn().mockResolvedValue({ ok: true }),
    setReceiverAccess: jest.fn(
      async (_id: string, disabled: boolean, actor: { id: string; role: string }) => {
        auditRows.push({
          id: `audit_${auditRows.length + 1}`,
          createdAt: new Date(),
          actorId: actor.id,
          actorRole: actor.role,
          action: 'receivers.setAccess',
          resourceType: 'receiver',
          resourceId: 'rcv_1',
          metadata: { disabled },
        });
        return { id: 'rcv_1', disabled };
      },
    ),
    approveReceiver: jest.fn(
      async (_id: string, redirect_url: string, actor: { id: string; role: string }) => {
        auditRows.push({
          id: `audit_${auditRows.length + 1}`,
          createdAt: new Date(),
          actorId: actor.id,
          actorRole: actor.role,
          action: 'receivers.approve',
          resourceType: 'receiver',
          resourceId: 'rcv_1',
          metadata: { redirect_url },
        });
        return { id: 'rcv_1', url: 'https://tos' };
      },
    ),
    enableReceiver: jest.fn(
      async (_id: string, tos_id: string, actor: { id: string; role: string }) => {
        auditRows.push({
          id: `audit_${auditRows.length + 1}`,
          createdAt: new Date(),
          actorId: actor.id,
          actorRole: actor.role,
          action: 'receivers.enable',
          resourceType: 'receiver',
          resourceId: 'rcv_1',
          metadata: { tos_id },
        });
        return { id: 'rcv_1', status: 'active' };
      },
    ),
    requestReceiverTos: jest.fn(
      async (
        _id: string,
        dto: { redirect_url: string; channel?: string },
        actor: { id: string; role: string },
      ) => {
        auditRows.push({
          id: `audit_${auditRows.length + 1}`,
          createdAt: new Date(),
          actorId: actor.id,
          actorRole: actor.role,
          action: 'receivers.requestTos',
          resourceType: 'receiver',
          resourceId: 'rcv_1',
          metadata: {
            channel: dto.channel ?? 'code',
            redirect_url: dto.redirect_url,
          },
        });
        return { id: 'rcv_1', url: 'https://tos', email: 'a@b.c' };
      },
    ),
  };

  const prismaMock: any = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: async (arg: any) => {
      if (typeof arg === 'function') return arg(prismaMock);
      return Promise.all(arg);
    },
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'rl_1' }) },
    webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]) },
    adminAuditLog: {
      create: jest.fn(({ data }: any) => {
        const row = { id: `audit_${auditRows.length + 1}`, createdAt: new Date(), ...data };
        auditRows.push(row);
        return Promise.resolve(row);
      }),
      findMany: jest.fn(() =>
        Promise.resolve([...auditRows].sort((a, b) => b.createdAt - a.createdAt)),
      ),
      count: jest.fn(() => Promise.resolve(auditRows.length)),
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(AdminService)
      .useValue(adminServiceMock)
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
  const base = '/v1/admin';

  const gateway = (r: request.Test) =>
    r
      .set('x-gateway-secret', 'topsecret')
      .set('x-consumer-username', 'cosmos_admin');

  const asRead = (r: request.Test) =>
    gateway(r).set('Authorization', 'Bearer read-secret-000000');
  const asWrite = (r: request.Test) =>
    gateway(r).set('Authorization', 'Bearer write-secret-00000');

  const mutators: Array<{
    name: string;
    method: 'patch' | 'post';
    path: string;
    body: Record<string, unknown>;
    action: string;
  }> = [
    {
      name: 'PATCH receivers/:id/access',
      method: 'patch',
      path: `${base}/receivers/rcv_1/access`,
      body: { disabled: true },
      action: 'receivers.setAccess',
    },
    {
      name: 'POST receivers/:id/approve',
      method: 'post',
      path: `${base}/receivers/rcv_1/approve`,
      body: { redirect_url: 'https://app.example/return' },
      action: 'receivers.approve',
    },
    {
      name: 'POST receivers/:id/enable',
      method: 'post',
      path: `${base}/receivers/rcv_1/enable`,
      body: { tos_id: 'to_abc123' },
      action: 'receivers.enable',
    },
    {
      name: 'POST receivers/:id/tos',
      method: 'post',
      path: `${base}/receivers/rcv_1/tos`,
      body: { redirect_url: 'https://app.example/return' },
      action: 'receivers.requestTos',
    },
  ];

  it('rejects legacy plaintext X-Cosmos-Admin: 1 with 401', async () => {
    await gateway(request(http()).get(`${base}/summary`))
      .set('x-cosmos-admin', '1')
      .expect(401);
  });

  it('allows a read credential on a read endpoint', async () => {
    await asRead(request(http()).get(`${base}/summary`)).expect(200);
  });

  describe.each(mutators)('$name', ({ method, path, body, action }) => {
    it('returns 401 without admin credentials', async () => {
      await gateway(request(http())[method](path).send(body)).expect(401);
    });

    it('returns 403 with a read-only credential', async () => {
      await asRead(request(http())[method](path).send(body)).expect(403);
    });

    it('allows write and appends an audit row', async () => {
      const before = auditRows.length;
      await asWrite(request(http())[method](path).send(body)).expect(
        (res) => {
          if (res.status < 200 || res.status >= 300) {
            throw new Error(`expected 2xx, got ${res.status}: ${JSON.stringify(res.body)}`);
          }
        },
      );
      expect(auditRows.length).toBe(before + 1);
      expect(auditRows[auditRows.length - 1]).toMatchObject({
        actorId: 'owner',
        actorRole: 'write',
        action,
        resourceType: 'receiver',
        resourceId: 'rcv_1',
      });
    });
  });

  it('exposes consultable audit logs to read credentials', async () => {
    const res = await asRead(request(http()).get(`${base}/audit-logs`)).expect(
      200,
    );
    expect(res.body.total).toBeGreaterThanOrEqual(4);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('does not expose a DELETE route for audit logs', async () => {
    await asWrite(request(http()).delete(`${base}/audit-logs`)).expect(404);
    await asWrite(request(http()).delete(`${base}/audit-logs/audit_1`)).expect(
      404,
    );
  });
});
