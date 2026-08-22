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
    const service = new WebhooksService(prisma as any, dispatcher, guard);
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
    } as any);

    expect(created.url).toBe('https://integrator.example.com/hooks');
    expect(prisma.webhookEndpoint.create).toHaveBeenCalled();
  });
});
