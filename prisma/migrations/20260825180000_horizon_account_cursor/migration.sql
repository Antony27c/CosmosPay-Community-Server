-- Persist Horizon paging tokens per payment intent so matching can resume
-- across observer cycles without one intent consuming another's payments
-- on a shared destination account (issue #27).

CREATE TABLE "horizon_account_cursor" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "pagingToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "horizon_account_cursor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "horizon_account_cursor_intentId_key" ON "horizon_account_cursor"("intentId");

ALTER TABLE "horizon_account_cursor" ADD CONSTRAINT "horizon_account_cursor_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "payment_intent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
