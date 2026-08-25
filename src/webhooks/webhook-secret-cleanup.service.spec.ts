import { Logger } from '@nestjs/common';
import { WebhookSecretCleanupService } from './webhook-secret-cleanup.service';

describe('WebhookSecretCleanupService', () => {
  function build() {
    const prisma = {
      webhookEndpoint: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const service = new WebhookSecretCleanupService(prisma as any);
    return { service, prisma };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('starts an unrefed interval and clears it on destroy', () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const fakeTimer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
    const setIntervalSpy = jest
      .spyOn(global, 'setInterval')
      .mockReturnValue(fakeTimer);
    const clearSpy = jest
      .spyOn(global, 'clearInterval')
      .mockImplementation(() => undefined);

    const { service } = build();
    service.onModuleInit();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect((fakeTimer as any).unref).toHaveBeenCalled();

    service.onModuleDestroy();
    expect(clearSpy).toHaveBeenCalledWith(fakeTimer);
  });

  it('nulls previousSecret when previousSecretExpiresAt has passed', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const { service, prisma } = build();
    prisma.webhookEndpoint.updateMany.mockResolvedValueOnce({ count: 2 });

    await service.tick();

    expect(prisma.webhookEndpoint.updateMany).toHaveBeenCalledWith({
      where: {
        previousSecret: { not: null },
        previousSecretExpiresAt: { lte: expect.any(Date) },
      },
      data: {
        previousSecret: null,
        previousSecretExpiresAt: null,
      },
    });
  });

  it('skips overlapping ticks (re-entry guard)', async () => {
    const { service, prisma } = build();
    let release!: () => void;
    prisma.webhookEndpoint.updateMany.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ count: 0 });
        }),
    );

    const first = service.tick();
    const second = service.tick();
    release();
    await Promise.all([first, second]);

    expect(prisma.webhookEndpoint.updateMany).toHaveBeenCalledTimes(1);
  });
});
