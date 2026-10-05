-- AlterTable
ALTER TABLE "payments" ADD COLUMN "receiptCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "payments_receiptCode_key" ON "payments"("receiptCode");
