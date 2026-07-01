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
  it("returns 0 without querying items when sync settings are missing", async () => {
    syncSettingsFindUniqueMock.mockResolvedValueOnce(null);
    const { processQueueOnce } = await import("./worker.server");

    const result = await processQueueOnce(SHOP);

    expect(result).toBe(0);
    expect(syncItemFindManyMock).not.toHaveBeenCalled();
  });

  it("returns 0 when sync is disabled for the shop", async () => {
    syncSettingsFindUniqueMock.mockResolvedValueOnce({
      shop: SHOP,
      syncEnabled: false,
    });
    const { processQueueOnce } = await import("./worker.server");

    const result = await processQueueOnce(SHOP);

    expect(result).toBe(0);
    expect(syncItemFindManyMock).not.toHaveBeenCalled();
  });

  it("processes up to `limit` pending items when sync is enabled", async () => {
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
