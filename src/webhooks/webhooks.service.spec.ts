import { BadRequestException } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { WebhookDestinationGuard } from './webhook-destination.guard';

describe('WebhooksService destination validation', () => {
  const consumer = {
    username: 'cosmos_u1',
    credentialId: 'cred_1',
  } as any;

  function build() {
    const prisma = {
      consumer: {
        upsert: jest.fn().mockResolvedValue({ id: 'c1' }),
      },
      webhookEndpoint: {
        create: jest.fn(({ data }: any) =>
          Promise.resolve({
            id: 'we_new',
            secret: 'whsec_x',
            enabled: true,
            destinationBlocked: false,
            eventTypes: [],
            description: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            consumerId: 'c1',
            ...data,
          }),
        ),
      },
    };
    const guard = new WebhookDestinationGuard();
    const dispatcher = {} as any;
    const config = { get: () => ({ secretGraceSeconds: 86400 }) } as any;
    const service = new WebhooksService(
      prisma as any,
      dispatcher,
      guard,
      config,
    );
    return { service, prisma, guard };
  }

  it('rejects registering a loopback endpoint with BadRequestException', async () => {
    const { service, prisma } = build();

    await expect(
      service.create(consumer, {
        url: 'https://127.0.0.1/hooks',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.webhookEndpoint.create).not.toHaveBeenCalled();
  });

  it('rejects private, link-local and metadata destinations at register', async () => {
    const { service } = build();

    await expect(
      service.create(consumer, { url: 'https://10.0.0.1/h' } as any),
    ).rejects.toThrow(/private/i);

    await expect(
      service.create(consumer, { url: 'https://169.254.1.1/h' } as any),
    ).rejects.toThrow(/link-local|cloud-metadata/i);

    await expect(
      service.create(consumer, {
        url: 'https://169.254.169.254/latest/meta-data',
      } as any),
    ).rejects.toThrow(/link-local|cloud-metadata/i);

    await expect(
      service.create(consumer, {
        url: 'http://integrator.example.com/h',
      } as any),
    ).rejects.toThrow(/https scheme/i);
  });

  it('allows a public https destination', async () => {
    const { service, prisma, guard } = build();
    guard.replaceDnsLookup(async () => ['93.184.216.34']);

    const created = await service.create(consumer, {
      url: 'https://integrator.example.com/hooks',
    });

    expect(created.url).toBe('https://integrator.example.com/hooks');
    expect(prisma.webhookEndpoint.create).toHaveBeenCalled();
  });
});

describe('WebhooksService secret rotation', () => {
  const consumer = {
    username: 'cosmos_u1',
    credentialId: 'cred_1',
  } as any;

  const current = {
    id: 'we_1',
    url: 'https://integrator.example.com/hooks',
    secret: 'whsec_aaa',
    previousSecret: null as string | null,
    previousSecretExpiresAt: null as Date | null,
    enabled: true,
    destinationBlocked: false,
    eventTypes: [],
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    consumerId: 'c1',
  };

  function build(secretGraceSeconds = 86400) {
    const prisma = {
      webhookEndpoint: {
        findFirst: jest.fn().mockResolvedValue({ ...current }),
        update: jest.fn(({ data }: any) =>
          Promise.resolve({ ...current, ...data, updatedAt: new Date() }),
        ),
        findMany: jest.fn().mockResolvedValue([{ ...current }]),
      },
    };
    const guard = new WebhookDestinationGuard();
    const dispatcher = {} as any;
    const config = { get: () => ({ secretGraceSeconds }) } as any;
    const service = new WebhooksService(
      prisma as any,
      dispatcher,
      guard,
      config,
    );
    return { service, prisma };
  }

  it('moves the current secret to previousSecret and sets previousSecretExpiresAt', async () => {
    const { service, prisma } = build();
    const before = Date.now();
    const rotated = await service.rotateSecret(consumer, 'we_1', {});

    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(current.secret);
    expect((rotated as any).previousSecret).toBeUndefined();
    expect(rotated.previousSecretExpiresAt).toBeInstanceOf(Date);
    expect(rotated.previousSecretExpiresAt!.getTime()).toBeGreaterThanOrEqual(
      before + 86400 * 1000 - 50,
    );

    expect(prisma.webhookEndpoint.update).toHaveBeenCalledWith({
      where: { id: 'we_1' },
      data: {
        secret: rotated.secret,
        previousSecret: current.secret,
        previousSecretExpiresAt: rotated.previousSecretExpiresAt,
      },
    });
  });

  it('graceSeconds=0 revokes immediately (no previousSecret stored)', async () => {
    const { service, prisma } = build();
    const rotated = await service.rotateSecret(consumer, 'we_1', {
      graceSeconds: 0,
    });

    expect(rotated.secret).not.toBe(current.secret);
    expect(rotated.previousSecretExpiresAt).toBeNull();
    expect(prisma.webhookEndpoint.update).toHaveBeenCalledWith({
      where: { id: 'we_1' },
      data: {
        secret: rotated.secret,
        previousSecret: null,
        previousSecretExpiresAt: null,
      },
    });
  });

  it('graceSeconds=0 during an open grace window still drops the original secret', async () => {
    const { service, prisma } = build();
    prisma.webhookEndpoint.findFirst.mockResolvedValueOnce({
      ...current,
      secret: 'whsec_bbb',
      previousSecret: 'whsec_aaa',
      previousSecretExpiresAt: new Date(Date.now() + 86400 * 1000),
    });

    await service.rotateSecret(consumer, 'we_1', { graceSeconds: 0 });

    expect(prisma.webhookEndpoint.update).toHaveBeenCalledWith({
      where: { id: 'we_1' },
      data: {
        secret: expect.stringMatching(/^whsec_/),
        previousSecret: null,
        previousSecretExpiresAt: null,
      },
    });
  });

  it('second rotation within grace keeps the original previousSecret', async () => {
    const originalExpiry = new Date(Date.now() + 86400 * 1000);
    const { service, prisma } = build();
    prisma.webhookEndpoint.findFirst.mockResolvedValueOnce({
      ...current,
      secret: 'whsec_bbb',
      previousSecret: 'whsec_aaa',
      previousSecretExpiresAt: originalExpiry,
    });

    const rotated = await service.rotateSecret(consumer, 'we_1', {});

    expect(rotated.secret).not.toBe('whsec_bbb');
    expect(prisma.webhookEndpoint.update).toHaveBeenCalledWith({
      where: { id: 'we_1' },
      data: {
        secret: rotated.secret,
        previousSecret: 'whsec_aaa',
        previousSecretExpiresAt: originalExpiry,
      },
    });
  });

  it('rotation after the grace window expires promotes the current secret', async () => {
    const { service, prisma } = build();
    prisma.webhookEndpoint.findFirst.mockResolvedValueOnce({
      ...current,
      secret: 'whsec_bbb',
      previousSecret: 'whsec_aaa',
      previousSecretExpiresAt: new Date(Date.now() - 1000),
    });

    const before = Date.now();
    const rotated = await service.rotateSecret(consumer, 'we_1', {});

    expect(prisma.webhookEndpoint.update).toHaveBeenCalledWith({
      where: { id: 'we_1' },
      data: {
        secret: rotated.secret,
        previousSecret: 'whsec_bbb',
        previousSecretExpiresAt: rotated.previousSecretExpiresAt,
      },
    });
    expect(rotated.previousSecretExpiresAt!.getTime()).toBeGreaterThanOrEqual(
      before + 86400 * 1000 - 50,
    );
  });

  it('rejects graceSeconds above the configured maximum with 400', async () => {
    const { service, prisma } = build(3600);
    await expect(
      service.rotateSecret(consumer, 'we_1', { graceSeconds: 3601 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.rotateSecret(consumer, 'we_1', { graceSeconds: 3601 }),
    ).rejects.toThrow(/cannot exceed the configured maximum \(3600\)/);
    expect(prisma.webhookEndpoint.update).not.toHaveBeenCalled();
  });

  it('strip omits secret and previousSecret on list/get', async () => {
    const { service, prisma } = build();
    prisma.webhookEndpoint.findMany.mockResolvedValueOnce([
      {
        ...current,
        previousSecret: 'whsec_old',
        previousSecretExpiresAt: new Date(Date.now() + 1000),
      },
    ]);
    prisma.webhookEndpoint.findFirst.mockResolvedValueOnce({
      ...current,
      previousSecret: 'whsec_old',
      previousSecretExpiresAt: new Date(Date.now() + 1000),
    });

    const listed = await service.findAll(consumer);
    expect((listed[0] as any).secret).toBeUndefined();
    expect((listed[0] as any).previousSecret).toBeUndefined();
    expect(listed[0].previousSecretExpiresAt).toBeInstanceOf(Date);

    const one = await service.findOne(consumer, 'we_1');
    expect((one as any).secret).toBeUndefined();
    expect((one as any).previousSecret).toBeUndefined();
    expect(one.previousSecretExpiresAt).toBeInstanceOf(Date);
  });
});
