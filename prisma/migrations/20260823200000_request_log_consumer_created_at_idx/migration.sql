-- Replace the single-column consumer index with a composite that covers the
-- dashboard query (WHERE consumer = ? ORDER BY "createdAt" DESC LIMIT n).
-- Keep request_log_createdAt_idx for the retention prune path.

DROP INDEX IF EXISTS "request_log_consumer_idx";

CREATE INDEX "request_log_consumer_createdAt_idx" ON "request_log"("consumer", "createdAt");
