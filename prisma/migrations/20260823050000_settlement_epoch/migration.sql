-- Discriminator for terminal webhook dedup: bumped only when a FAILED row is
-- resubmitted. Concurrent observer+submit of the same attempt keep the same
-- epoch and therefore the same unique key.
ALTER TABLE "swap" ADD COLUMN "settlementEpoch" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "liquidity_pool_operation" ADD COLUMN "settlementEpoch" INTEGER NOT NULL DEFAULT 0;
