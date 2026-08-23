-- Claim table for terminal webhook events. Inserting a row is winning the
-- right to notify integrators; the unique index on dedupKey makes a race
-- between observer and submit produce a single event.
CREATE TABLE "webhook_emitted_event" (
    "id" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "eventType" "WebhookEventType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_emitted_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webhook_emitted_event_dedupKey_key" ON "webhook_emitted_event"("dedupKey");
