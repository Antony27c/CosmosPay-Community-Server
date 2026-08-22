-- CreateTable
CREATE TABLE "payment_intent_transition" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "fromStatus" "PaymentIntentStatus" NOT NULL,
    "toStatus" "PaymentIntentStatus" NOT NULL,
    "txHash" TEXT,
    "actor" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_intent_transition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_intent_transition_intentId_createdAt_idx" ON "payment_intent_transition"("intentId", "createdAt");

-- AddForeignKey
ALTER TABLE "payment_intent_transition" ADD CONSTRAINT "payment_intent_transition_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "payment_intent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
