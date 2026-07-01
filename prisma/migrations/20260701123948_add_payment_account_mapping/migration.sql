-- AlterTable
ALTER TABLE "SyncSettings" ADD COLUMN "defaultCheckAccountId" TEXT;

-- CreateTable
CREATE TABLE "PaymentAccountMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "gatewayName" TEXT NOT NULL,
    "checkAccountId" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAccountMapping_shop_gatewayName_key" ON "PaymentAccountMapping"("shop", "gatewayName");
