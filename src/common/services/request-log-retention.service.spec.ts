import { Logger } from '@nestjs/common';
import { RequestLogRetentionService } from './request-log-retention.service';

describe('RequestLogRetentionService', () => {
  const retentionCfg = {
    retentionDays: 30,
    pruneIntervalMs: 3600000,
    batchSize: 2,
  };

  function build(cfg = retentionCfg) {
    const prisma = {
      requestLog: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const config = { get: () => cfg } as any;
    const service = new RequestLogRetentionService(config, prisma as any);
    return { service, prisma };
  }

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('logs disabled and skips the timer when retentionDays is 0', () => {
    const loggerLog = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    const { service } = build({
      retentionDays: 0,
      pruneIntervalMs: 3600000,
      batchSize: 1000,
    });
    service.onModuleInit();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(loggerLog).toHaveBeenCalledWith(
      'Request log retention disabled (REQUEST_LOG_RETENTION_DAYS=0)',
    );
    service.onModuleDestroy();
  });

  it('starts an unrefed interval when retention is enabled', () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();

    const fakeTimer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
    const setIntervalSpy = jest
      .spyOn(global, 'setInterval')
      .mockReturnValue(fakeTimer);

    const { service } = build();
    service.onModuleInit();

    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      retentionCfg.pruneIntervalMs,
    );
    expect((fakeTimer as any).unref).toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('deletes at most batchSize stale rows and logs the count', async () => {
    const loggerLog = jest.spyOn(Logger.prototype, 'log').mockImplementation();

    const stale = [{ id: 'a' }, { id: 'b' }];
    const { service, prisma } = build();
    prisma.requestLog.findMany.mockResolvedValue(stale);
    prisma.requestLog.deleteMany.mockResolvedValue({ count: 2 });

    await (service as any).tick();

    expect(prisma.requestLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        where: { createdAt: { lt: expect.any(Date) } },
      }),
    );
    expect(prisma.requestLog.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b'] } },
    });
    expect(loggerLog).toHaveBeenCalledWith(
      expect.stringMatching(/Request log prune deleted 2 row/),
    );
  });

  it('does not delete when there are no stale rows', async () => {
    const { service, prisma } = build();
    await (service as any).tick();
    expect(prisma.requestLog.deleteMany).not.toHaveBeenCalled();
  });

  it('does not start a second cycle while one is still running', async () => {
    const { service, prisma } = build();
    let resolveFind!: (v: unknown) => void;
    prisma.requestLog.findMany.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFind = resolve;
        }),
    );

    const first = (service as any).tick();
    const second = (service as any).tick();
    await second;

    expect(prisma.requestLog.findMany).toHaveBeenCalledTimes(1);

    resolveFind([]);
    await first;
  });

  it('clearInterval on destroy so the process can exit', () => {
    const fakeTimer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
    jest.spyOn(global, 'setInterval').mockReturnValue(fakeTimer);
    const clearSpy = jest.spyOn(global, 'clearInterval').mockImplementation();

    const { service } = build();
    service.onModuleInit();
    service.onModuleDestroy();

    expect(clearSpy).toHaveBeenCalledWith(fakeTimer);
  });
});
