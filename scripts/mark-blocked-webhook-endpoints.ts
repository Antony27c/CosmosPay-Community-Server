/**
 * One-shot audit: mark webhook endpoints whose URL is no longer an allowed
 * public https destination (loopback / private / link-local / metadata / http).
 *
 * Usage (from repo root, with DATABASE_URL set):
 *   npx ts-node --transpile-only scripts/mark-blocked-webhook-endpoints.ts
 *
 * Migration for integrators:
 * 1. Run this script after deploying the destination-guard release.
 * 2. Endpoints that fail checks get destinationBlocked=true and enabled=false.
 * 3. Integrators PATCH /v1/webhooks/:id with a public https URL (or set
 *    enabled=true after fixing DNS) — validation runs again and clears the flag.
 */
import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { assertPublicWebhookUrl } from '../src/webhooks/webhook-url.validator';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  const endpoints = await prisma.webhookEndpoint.findMany({
    select: { id: true, url: true, enabled: true, destinationBlocked: true },
  });

  let blocked = 0;
  let ok = 0;

  for (const endpoint of endpoints) {
    try {
      await assertPublicWebhookUrl(endpoint.url);
      ok += 1;
      if (endpoint.destinationBlocked) {
        // Leave already-blocked rows alone unless an operator clears them via API.
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await prisma.webhookEndpoint.update({
        where: { id: endpoint.id },
        data: { destinationBlocked: true, enabled: false },
      });
      blocked += 1;
      console.log(`blocked ${endpoint.id} (${endpoint.url}): ${reason}`);
    }
  }

  console.log(
    `Audit complete: ${ok} allowed, ${blocked} marked destinationBlocked.`,
  );
  await prisma.$disconnect();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
