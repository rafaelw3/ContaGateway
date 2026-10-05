-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "pixPayload" TEXT NOT NULL,
    "qrId" TEXT,
    "transactionHash" TEXT,
    "idempotencyKey" TEXT,
    "metadata" TEXT,
    "webhookUrl" TEXT,
    "webhookStatus" TEXT DEFAULT 'PENDING',
    "webhookAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_qrId_key" ON "payments"("qrId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_transactionHash_key" ON "payments"("transactionHash");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotencyKey_key" ON "payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payments_status_amount_idx" ON "payments"("status", "amount");
