import { beforeEach, describe, expect, it, vi } from "vitest";

const syncSettingsFindUniqueMock = vi.fn();
const syncItemFindManyMock = vi.fn();
const syncItemUpdateMock = vi.fn();
const syncItemUpdateManyMock = vi.fn().mockResolvedValue({ count: 0 });
vi.mock("../db.server", () => ({
  default: {
    syncSettings: { findUnique: syncSettingsFindUniqueMock },
    syncItem: {
      findMany: syncItemFindManyMock,
      update: syncItemUpdateMock,
      updateMany: syncItemUpdateManyMock,
    },
  },
}));

const processSyncItemMock = vi.fn();
vi.mock("./processor.server", () => ({
  processSyncItem: processSyncItemMock,
}));

const SHOP = "example.myshopify.com";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processQueueOnce", () => {
  it("only processes manual (backfill) items when sync settings are missing", async () => {
    syncSettingsFindUniqueMock.mockResolvedValueOnce(null);
    syncItemFindManyMock.mockResolvedValueOnce([]);
    const { processQueueOnce } = await import("./worker.server");

    const result = await processQueueOnce(SHOP);

    expect(result).toBe(0);
    expect(syncItemFindManyMock).toHaveBeenCalledExactlyOnceWith({
      where: { shop: SHOP, status: "pending", topic: "backfill" },
      orderBy: { createdAt: "asc" },
      take: 5,
    });
  });

  it("only processes manual (backfill) items when sync is disabled for the shop", async () => {
    syncSettingsFindUniqueMock.mockResolvedValueOnce({
      shop: SHOP,
      syncEnabled: false,
    });
    const items = [{ id: "item-1", shop: SHOP, topic: "backfill" }];
    syncItemFindManyMock.mockResolvedValueOnce(items);
    const { processQueueOnce } = await import("./worker.server");

    const result = await processQueueOnce(SHOP);

    expect(syncItemFindManyMock).toHaveBeenCalledExactlyOnceWith({
      where: { shop: SHOP, status: "pending", topic: "backfill" },
      orderBy: { createdAt: "asc" },
      take: 5,
    });
    expect(processSyncItemMock).toHaveBeenCalledTimes(1);
    expect(result).toBe(1);
  });

  it("processes up to `limit` pending items of any topic when sync is enabled", async () => {
    syncSettingsFindUniqueMock.mockResolvedValueOnce({
      shop: SHOP,
      syncEnabled: true,
    });
    const items = [
      { id: "item-1", shop: SHOP },
      { id: "item-2", shop: SHOP },
    ];
    syncItemFindManyMock.mockResolvedValueOnce(items);
    const { processQueueOnce } = await import("./worker.server");

    const result = await processQueueOnce(SHOP, 2);

    expect(syncItemFindManyMock).toHaveBeenCalledExactlyOnceWith({
      where: { shop: SHOP, status: "pending" },
      orderBy: { createdAt: "asc" },
      take: 2,
    });
    expect(syncItemUpdateMock).toHaveBeenCalledTimes(2);
    expect(processSyncItemMock).toHaveBeenCalledTimes(2);
    expect(result).toBe(2);
  });
});
