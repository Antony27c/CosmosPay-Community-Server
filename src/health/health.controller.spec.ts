import {
  INestApplication,
  ServiceUnavailableException,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaHealthIndicator, TerminusModule } from '@nestjs/terminus';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { HealthController } from './health.controller';
import { StellarHealthIndicator } from './stellar-health.indicator';

describe('GET /v1/health/readiness Horizon checks', () => {
  const horizon = {
    public: 'https://horizon.example/public',
    testnet: 'https://horizon.example/testnet',
  };

  async function makeApp(call: jest.Mock): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [HealthController],
      providers: [
        StellarHealthIndicator,
        {
          provide: PrismaHealthIndicator,
          useValue: {
            pingCheck: async (key: string) => ({ [key]: { status: 'up' } }),
          },
        },
        { provide: PrismaService, useValue: {} },
        { provide: StellarService, useValue: { call } },
        {
          provide: ConfigService,
          useValue: { get: () => ({ horizon }) },
        },
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    return app;
  }

  afterEach(async () => {
    jest.restoreAllMocks();
  });

  it('returns 200 with horizon.testnet and horizon.public up when Horizon responds', async () => {
    const call = jest.fn().mockResolvedValue({ core_latest_ledger: 1 });
    const app = await makeApp(call);

    const res = await request(app.getHttpServer())
      .get('/v1/health/readiness')
      .expect(200);

    expect(res.body.status).toBe('ok');
    expect(res.body.info.database.status).toBe('up');
    expect(res.body.info['horizon.testnet'].status).toBe('up');
    expect(res.body.info['horizon.public'].status).toBe('up');
    expect(res.body.error).toEqual({});

    await app.close();
  });

  it('returns 503 with horizon.* down when Horizon is unreachable', async () => {
    const call = jest
      .fn()
      .mockRejectedValue(
        new ServiceUnavailableException('Could not reach the Stellar network'),
      );
    const app = await makeApp(call);

    const res = await request(app.getHttpServer())
      .get('/v1/health/readiness')
      .expect(503);

    expect(res.body.status).toBe('error');
    expect(res.body.error['horizon.testnet'].status).toBe('down');
    expect(res.body.error['horizon.public'].status).toBe('down');
    expect(res.body.error['horizon.testnet'].message).toMatch(
      /Could not reach the Stellar network/,
    );

    await app.close();
  });
});
