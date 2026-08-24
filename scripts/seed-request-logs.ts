/**
 * Seeds `request_log` with N rows whose createdAt is spread across the last
 * several days — useful to measure the composite index and exercise retention.
 *
 *   npx ts-node --transpile-only scripts/seed-request-logs.ts [count] [consumer]
 *
 * Defaults: 1000 rows for consumer `seed_consumer`.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

async function main(): Promise<void> {
  const count = Math.max(1, parseInt(process.argv[2] ?? '1000', 10) || 1000);
  const consumer = process.argv[3] ?? 'seed_consumer';
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  // Spread across ~7 days so prune (e.g. RETENTION_DAYS=1) has clear stale rows.
  const spanMs = 7 * dayMs;

  const rows = Array.from({ length: count }, (_, i) => {
    const createdAt = new Date(now - Math.floor((i / count) * spanMs));
    return {
      consumer,
      method: i % 3 === 0 ? 'POST' : 'GET',
      path: i % 2 === 0 ? '/v1/payment-intents' : '/v1/swaps',
      statusCode: i % 11 === 0 ? 500 : i % 7 === 0 ? 400 : 200,
      durationMs: 5 + (i % 200),
      ip: `203.0.113.${(i % 254) + 1}`,
      userAgent: `seed-agent/${i % 10}`,
      createdAt,
    };
  });

  // createMany in chunks to stay under parameter limits.
  const chunk = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const result = await prisma.requestLog.createMany({ data: slice });
    inserted += result.count;
  }

  // eslint-disable-next-line no-console
  console.log(
    `Seeded ${inserted} request_log row(s) for consumer=${consumer} (span ~7d)`,
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
