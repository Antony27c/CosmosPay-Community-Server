import {
  INestApplication,
  ServiceUnavailableException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { PaymentIntentsController } from './payment-intents.controller';
import { PaymentIntentsService } from './payment-intents.service';
import { StellarVerifierService } from './stellar-verifier.service';

const TX_HASH = 'a'.repeat(64);

describe('POST /v1/payment-intents/:id/validate Horizon errors', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns 503 with a clear message when Horizon is unreachable (not 500)', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PaymentIntentsController],
      providers: [
        {
          provide: APP_FILTER,
          useClass: AllExceptionsFilter,
        },
        {
          provide: PaymentIntentsService,
          useValue: {
            validate: jest
              .fn()
              .mockRejectedValue(
                new ServiceUnavailableException(
                  'Could not reach the Stellar network',
                ),
              ),
          },
        },
      ],
    }).compile();

    const app: INestApplication = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.use(
      (req: { gatewayConsumer?: unknown }, _res: unknown, next: () => void) => {
        req.gatewayConsumer = {
          username: 'cosmos_u1',
          credentialId: 'cred_1',
          environment: 'dev',
          role: 'user',
          permissions: ['payments:write'],
          organizationId: null,
          plan: null,
          planSwapFeeBps: null,
        };
        next();
      },
    );
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    const res = await request(app.getHttpServer())
      .post(`/v1/payment-intents/pi_1/validate`)
      .send({ txHash: TX_HASH });

    expect(res.body).toMatchObject({
      statusCode: 503,
      message: 'Could not reach the Stellar network',
    });
    expect(res.status).toBe(503);
    expect(res.status).not.toBe(500);

    await app.close();
  });

  it('lets StellarVerifierService surface ServiceUnavailableException from StellarService.call', async () => {
    const stellar = {
      call: jest
        .fn()
        .mockRejectedValue(
          new ServiceUnavailableException(
            'Could not reach the Stellar network',
          ),
        ),
    };
    const verifier = new StellarVerifierService(stellar as any, {
      horizonAccountCursor: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
    } as any);
    const intent = {
      id: 'pi_1',
      network: 'testnet',
      destination: 'GDEST',
      amount: '1',
      asset: 'native',
      assetIssuer: null,
      memo: '1',
    } as any;

    await expect(verifier.verifyByHash(intent, TX_HASH)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
