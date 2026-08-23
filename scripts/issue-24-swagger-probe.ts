/**
 * Single-shot /docs probe for issue #24 evidence.
 * Usage: npx ts-node --transpile-only scripts/issue-24-swagger-probe.ts
 * Set SWAGGER_ENABLED in the shell before running (omit for default-off in production).
 */
process.env.APISIX_GATEWAY_SECRET ??= 'topsecret';
process.env.DATABASE_URL ??= 'postgresql://x:x@localhost:5432/x';
process.env.NODE_ENV = 'production';
process.env.STELLAR_SWAP_FEE_WALLET ??=
  'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76';
process.env.OBSERVER_ENABLED = 'false';

import 'reflect-metadata';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { setupSwagger } from '../src/swagger';
import { PrismaService } from '../src/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../src/config/configuration';

const prismaMock = {
  onModuleInit: async () => {},
  onModuleDestroy: async () => {},
  $connect: async () => {},
  $disconnect: async () => {},
};

async function main(): Promise<void> {
  const swaggerFlag = process.env.SWAGGER_ENABLED ?? '(unset)';
  console.log('='.repeat(72));
  console.log(`CASE: NODE_ENV=production, SWAGGER_ENABLED=${swaggerFlag}`);
  console.log('='.repeat(72));
  console.log('$ curl -i http://localhost:3000/docs\n');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prismaMock)
    .compile();

  const app = moduleRef.createNestApplication();
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const config = app.get(ConfigService<AppConfig, true>);
  if (config.get('swaggerEnabled', { infer: true })) {
    setupSwagger(app);
  }

  await app.init();
  const res = await request(app.getHttpServer()).get('/docs');
  await app.close();

  const statusText =
    res.status === 404 ? 'Not Found' : res.status === 200 ? 'OK' : '';
  console.log(`HTTP/1.1 ${res.status} ${statusText}`);
  if (res.headers['content-type']) {
    console.log(`content-type: ${String(res.headers['content-type'])}`);
  }
  console.log(`\nstatus=${res.status}`);
}

void main();
