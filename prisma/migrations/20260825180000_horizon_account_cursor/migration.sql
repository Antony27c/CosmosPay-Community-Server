-- Persist Horizon paging tokens per destination account so payment-intent
-- matching can resume across observer cycles (issue #27).

CREATE TABLE "horizon_account_cursor" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "pagingToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "horizon_account_cursor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "horizon_account_cursor_network_account_key" ON "horizon_account_cursor"("network", "account");
