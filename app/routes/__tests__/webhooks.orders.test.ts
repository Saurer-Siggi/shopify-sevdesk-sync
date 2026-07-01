import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";

const authenticateWebhookMock = vi.fn();
vi.mock("../../shopify.server", () => ({
  authenticate: { webhook: authenticateWebhookMock },
}));

const syncItemCreateMock = vi.fn();
vi.mock("../../db.server", () => ({
  default: { syncItem: { create: syncItemCreateMock } },
}));

const SHOP = "example.myshopify.com";

function makeArgs(url: string): ActionFunctionArgs {
  return {
    request: new Request(url, { method: "POST" }),
    params: {},
    context: {},
    url: new URL(url),
    pattern: new URL(url).pathname,
  };
}

describe("orders webhooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("orders/create enqueues a pending SyncItem", async () => {
    authenticateWebhookMock.mockResolvedValue({
      shop: SHOP,
      topic: "orders/create",
      payload: { id: 8209829119461545, name: "#1034" },
    });
    const { action } = await import("../webhooks.orders.create");

    const response = await action(
      makeArgs("https://app.example/webhooks/orders/create"),
    );

    expect(response.status).toBe(200);
    expect(syncItemCreateMock).toHaveBeenCalledExactlyOnceWith({
      data: {
        shop: SHOP,
        shopifyOrderId: "8209829119461545",
        shopifyOrderName: "#1034",
        topic: "orders/create",
      },
    });
  });

  it("orders/paid enqueues a pending SyncItem", async () => {
    authenticateWebhookMock.mockResolvedValue({
      shop: SHOP,
      topic: "orders/paid",
      payload: { id: 8209829119461545, name: "#1034" },
    });
    const { action } = await import("../webhooks.orders.paid");

    await action(makeArgs("https://app.example/webhooks/orders/paid"));

    expect(syncItemCreateMock).toHaveBeenCalledExactlyOnceWith({
      data: {
        shop: SHOP,
        shopifyOrderId: "8209829119461545",
        shopifyOrderName: "#1034",
        topic: "orders/paid",
      },
    });
  });

  it("orders/cancelled enqueues a pending SyncItem", async () => {
    authenticateWebhookMock.mockResolvedValue({
      shop: SHOP,
      topic: "orders/cancelled",
      payload: { id: 8209829119461545, name: "#1034" },
    });
    const { action } = await import("../webhooks.orders.cancelled");

    await action(makeArgs("https://app.example/webhooks/orders/cancelled"));

    expect(syncItemCreateMock).toHaveBeenCalledExactlyOnceWith({
      data: {
        shop: SHOP,
        shopifyOrderId: "8209829119461545",
        shopifyOrderName: "#1034",
        topic: "orders/cancelled",
      },
    });
  });

  it("handles duplicate deliveries by inserting a second row, not crashing", async () => {
    authenticateWebhookMock.mockResolvedValue({
      shop: SHOP,
      topic: "orders/create",
      payload: { id: 8209829119461545, name: "#1034" },
    });
    const { action } = await import("../webhooks.orders.create");

    await action(makeArgs("https://app.example/webhooks/orders/create"));
    await action(makeArgs("https://app.example/webhooks/orders/create"));

    expect(syncItemCreateMock).toHaveBeenCalledTimes(2);
  });
});
