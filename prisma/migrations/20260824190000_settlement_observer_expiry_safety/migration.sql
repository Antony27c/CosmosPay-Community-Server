-- Settlement observer: distinguish Horizon 404 from transient errors before
-- expiring a row, and notify integrators when a swap/LP operation does expire.
-- lastCheckedAt / notFoundStreak are nullable/defaulted so existing rows stay valid.

-- AlterEnum
ALTER TYPE "WebhookEventType" ADD VALUE 'SWAP_EXPIRED';
ALTER TYPE "WebhookEventType" ADD VALUE 'LIQUIDITY_EXPIRED';

-- AlterTable
ALTER TABLE "swap" ADD COLUMN "lastCheckedAt" TIMESTAMP(3);
ALTER TABLE "swap" ADD COLUMN "notFoundStreak" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "liquidity_pool_operation" ADD COLUMN "lastCheckedAt" TIMESTAMP(3);
ALTER TABLE "liquidity_pool_operation" ADD COLUMN "notFoundStreak" INTEGER NOT NULL DEFAULT 0;
