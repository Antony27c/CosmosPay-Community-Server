-- Swap idempotency (issue #17): client Idempotency-Key + unique (network, txHash).
--
-- Before creating @@unique([network, txHash]), collapse any historical duplicate
-- hashes. For each (network, txHash) group we KEEP one row — preferring
-- SUCCEEDED, then SUBMITTED, then PENDING, then everything else, and among ties
-- the earliest createdAt — and DELETE the rest. Those deleted rows were phantom
-- swaps that could never both settle on-chain (shared sequence / identical XDR);
-- keeping them would block the unique index and would have caused duplicate
-- SWAP_SUCCEEDED webhooks. The surviving row retains the real on-chain identity.

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "network", "txHash"
      ORDER BY
        CASE "status"
          WHEN 'SUCCEEDED' THEN 0
          WHEN 'SUBMITTED' THEN 1
          WHEN 'PENDING' THEN 2
          WHEN 'FAILED' THEN 3
          ELSE 4
        END,
        "createdAt" ASC,
        id ASC
    ) AS rn
  FROM "swap"
)
DELETE FROM "swap"
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- AlterTable
ALTER TABLE "swap" ADD COLUMN "idempotencyKey" TEXT;

-- DropIndex (non-unique txHash index; replaced by unique (network, txHash))
DROP INDEX IF EXISTS "swap_txHash_idx";

-- CreateIndex
CREATE UNIQUE INDEX "swap_consumerId_idempotencyKey_key" ON "swap"("consumerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "swap_network_txHash_key" ON "swap"("network", "txHash");
