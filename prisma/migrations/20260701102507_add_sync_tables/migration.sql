-- CreateTable
CREATE TABLE "SyncSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "syncEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SyncItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderName" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sevdeskInvoiceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "SyncItem_shop_status_idx" ON "SyncItem"("shop", "status");

-- CreateIndex
CREATE INDEX "SyncItem_shop_shopifyOrderId_idx" ON "SyncItem"("shop", "shopifyOrderId");
