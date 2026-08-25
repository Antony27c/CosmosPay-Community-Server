import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { stringify } from 'yaml';
import { createOpenApiDocument } from '../src/swagger';

/**
 * Writes the OpenAPI spec to `openapi/openapi.{json,yaml}` without starting the
 * HTTP server. Runs in Nest "preview" mode so providers' lifecycle hooks are
 * NOT executed — no database/network connection is needed just to emit the spec.
 *
 *   npm run openapi:generate
 */
async function generate(): Promise<void> {
  // AppModule validates these variables while loading. Spec generation never
  // connects to Postgres or accepts gateway traffic, so deterministic local
  // placeholders keep this offline command independent from real credentials.
  process.env.DATABASE_URL ??=
    'postgresql://openapi:openapi@localhost:5432/openapi';
  process.env.APISIX_GATEWAY_SECRET ??= 'openapi-generation-only';
  // Default swap fee bps is 50; env validation requires a fee wallet when > 0.
  process.env.STELLAR_SWAP_FEE_WALLET ??=
    'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76';

  // Import only after the offline defaults are set: ConfigModule validates the
  // environment as soon as AppModule is evaluated.
  const { AppModule } = await import('../src/app.module');

  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
  });

  // Match runtime routing so paths in the spec are accurate (/v1/...).
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  const document = createOpenApiDocument(app);

  const outDir = join(process.cwd(), 'openapi');
  mkdirSync(outDir, { recursive: true });

  const jsonPath = join(outDir, 'openapi.json');
  const yamlPath = join(outDir, 'openapi.yaml');
  writeFileSync(jsonPath, JSON.stringify(document, null, 2), 'utf8');
  writeFileSync(yamlPath, stabilizeOpenApiYaml(stringify(document)), 'utf8');

  await app.close();

  console.log(`OpenAPI spec written to:\n  ${jsonPath}\n  ${yamlPath}`);
}

/**
 * Pin the Terminus health/readiness YAML anchors to the shape Ubuntu CI emits.
 * Without this, `openapi:check` flakes when local `yaml` assigns `&a2` on the
 * 200-response `database` node instead of the 503 `info` block (see a11d529).
 */
function stabilizeOpenApiYaml(yaml: string): string {
  return yaml
    .replace(/(example: &a1\n\s+database:) &a2\n/g, '$1\n')
    .replace(
      /(\n\s+example: error\n\s+info:\n\s+type: object\n\s+)example: \*a1\n/g,
      '$1example:\n                      database: &a2\n                        status: up\n',
    );
}

generate().catch((err) => {
  console.error('Failed to generate OpenAPI spec:', err);
  process.exit(1);
});
