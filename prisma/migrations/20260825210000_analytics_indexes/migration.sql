-- Composite index for analytics dashboard queries (consumer + network + time).
CREATE INDEX "payment_intent_consumerId_network_createdAt_idx" ON "payment_intent"("consumerId", "network", "createdAt");
