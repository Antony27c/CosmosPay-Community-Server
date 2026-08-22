import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Verifies the "only APISIX" gate independent of any specific domain logic:
 * requests are rejected unless they carry the gateway secret AND an
 * authenticated consumer, while @Public() probes stay open. We hit a real
 * protected route (POST /payment-intents) and assert the guard's decision —
 * a 400 (validation) on the allowed path proves the guard let the request
 * through. Prisma is mocked so the suite needs no database.
 */
describe('APISIX gateway validation (e2e)', () => {
  let app: INestApplication;

  const prismaMock = {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    requestLog: {
      create: jest.fn().mockResolvedValue({ id: 'rl_1' }),
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => app.getHttpServer();
  const route = '/v1/payment-intents/pay';

  it('rejects requests without the gateway secret (403)', () =>
    request(http()).post(route).send({}).expect(403));

  it('rejects requests with a wrong gateway secret (403)', () =>
    request(http())
      .post(route)
      .set('x-gateway-secret', 'nope')
      .send({})
      .expect(403));

  it('rejects valid secret without an authenticated consumer (401)', () =>
    request(http())
      .post(route)
      .set('x-gateway-secret', 'topsecret')
      .send({})
      .expect(401));

  it('lets valid secret + consumer through the guard (reaches validation → 400)', () =>
    request(http())
      .post(route)
      .set('x-gateway-secret', 'topsecret')
      .set('x-consumer-username', 'cosmos_u1')
      .set('x-consumer-permissions', 'payments:write')
      .send({})
      .expect(400));

  it('leaves @Public() probes open (200)', () =>
    request(http()).get('/v1/health/liveness').expect(200));
});
