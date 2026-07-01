import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";

const authenticateAdminMock = vi.fn();
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateAdminMock },
}));

const syncSettingsUpsertMock = vi.fn();
const syncSettingsUpdateMock = vi.fn();
const syncItemUpdateManyMock = vi.fn();
vi.mock("../../db.server", () => ({
  default: {
    syncSettings: {
      upsert: syncSettingsUpsertMock,
      update: syncSettingsUpdateMock,
    },
    syncItem: {
      updateMany: syncItemUpdateManyMock,
    },
  },
}));

const syncAllUnsyncedMock = vi.fn();
const syncOrdersMock = vi.fn();
const listOrdersMock = vi.fn();
vi.mock("../../sync/backfill.server", () => ({
  syncAllUnsynced: syncAllUnsyncedMock,
  syncOrders: syncOrdersMock,
  listOrders: listOrdersMock,
}));

const SHOP = "example.myshopify.com";

function makeArgs(formData: Record<string, string>): ActionFunctionArgs {
  const body = new URLSearchParams(formData);
  const request = new Request("https://app.example/app", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return {
    request,
    params: {},
    context: {},
  } as ActionFunctionArgs;
}

describe("app._index action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateAdminMock.mockResolvedValue({ session: { shop: SHOP } });
  });

  it("toggle flips syncEnabled for this shop", async () => {
    syncSettingsUpsertMock.mockResolvedValue({ shop: SHOP, syncEnabled: false });
    syncSettingsUpdateMock.mockResolvedValue({ shop: SHOP, syncEnabled: true });
    const { action } = await import("../app._index");

    const result = await action(makeArgs({ intent: "toggle" }));

    expect(syncSettingsUpdateMock).toHaveBeenCalledExactlyOnceWith({
      where: { shop: SHOP },
      data: { syncEnabled: true },
    });
    expect(result).toEqual({ intent: "toggle", syncEnabled: true });
  });

  it("sync-all-unsynced calls syncAllUnsynced with shop", async () => {
    syncAllUnsyncedMock.mockResolvedValue({ enqueued: 7, truncated: false });
    const { action } = await import("../app._index");

    const result = await action(makeArgs({ intent: "sync-all-unsynced" }));

    expect(syncAllUnsyncedMock).toHaveBeenCalledExactlyOnceWith(SHOP);
    expect(result).toEqual({
      intent: "sync-all-unsynced",
      enqueued: 7,
      truncated: false,
    });
  });

  it("retry only touches SyncItem rows matching the current shop", async () => {
    syncItemUpdateManyMock.mockResolvedValue({ count: 1 });
    const { action } = await import("../app._index");

    const result = await action(
      makeArgs({ intent: "retry", itemId: "item-123" }),
    );

    expect(syncItemUpdateManyMock).toHaveBeenCalledExactlyOnceWith({
      where: { id: "item-123", shop: SHOP, status: "error" },
      data: { status: "pending", lastError: null },
    });
    expect(result).toEqual({ intent: "retry", retried: true });
  });

  it("retry reports failure when no row matches this shop", async () => {
    syncItemUpdateManyMock.mockResolvedValue({ count: 0 });
    const { action } = await import("../app._index");

    const result = await action(
      makeArgs({ intent: "retry", itemId: "someone-elses-item" }),
    );

    expect(result).toEqual({ intent: "retry", retried: false });
  });

  it("sync-selected enqueues the given orders", async () => {
    syncOrdersMock.mockResolvedValue({ enqueued: 2 });
    const { action } = await import("../app._index");

    const orders = [
      { shopifyOrderId: "123", shopifyOrderName: "#1050" },
      { shopifyOrderId: "124", shopifyOrderName: "#1051" },
    ];
    const result = await action(
      makeArgs({ intent: "sync-selected", orders: JSON.stringify(orders) }),
    );

    expect(syncOrdersMock).toHaveBeenCalledExactlyOnceWith(SHOP, orders);
    expect(result).toEqual({ intent: "sync-selected", enqueued: 2 });
  });
});
