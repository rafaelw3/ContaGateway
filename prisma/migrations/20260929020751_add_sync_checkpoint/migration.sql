-- CreateTable
CREATE TABLE "sync_checkpoints" (
    "id" TEXT NOT NULL,
    "lastBlock" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_checkpoints_pkey" PRIMARY KEY ("id")
);
