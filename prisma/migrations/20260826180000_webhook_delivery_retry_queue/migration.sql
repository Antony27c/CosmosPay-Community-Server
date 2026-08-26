-- Durable webhook delivery queue. The dispatcher only enqueues; a retry worker
-- claims due rows via leaseUntil so a restart no longer leaves PENDING forever.
-- RETRYING distinguishes in-flight / scheduled retries from never-attempted
-- PENDING. Existing PENDING rows are backfilled so migrate deploy resumes them.

-- AlterEnum
ALTER TYPE "WebhookDeliveryStatus" ADD VALUE 'RETRYING';

-- AlterTable
ALTER TABLE "webhook_delivery" ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 8;
ALTER TABLE "webhook_delivery" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
ALTER TABLE "webhook_delivery" ADD COLUMN "leaseUntil" TIMESTAMP(3);

-- Rescue rows stuck PENDING by the old in-process retry loop.
UPDATE "webhook_delivery" SET "nextAttemptAt" = CURRENT_TIMESTAMP WHERE status = 'PENDING';

-- DropIndex (composite leftmost prefix still serves status-only lookups)
DROP INDEX "webhook_delivery_status_idx";

-- CreateIndex
CREATE INDEX "webhook_delivery_status_nextAttemptAt_idx" ON "webhook_delivery"("status", "nextAttemptAt");
