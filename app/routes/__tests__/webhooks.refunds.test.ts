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

describe("refunds/create webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enqueues a SyncItem using order_id since the refund payload has no order name", async () => {
    authenticateWebhookMock.mockResolvedValue({
      shop: SHOP,
      topic: "refunds/create",
      payload: { id: 5095629, order_id: 8209829119461545 },
    });
    const { action } = await import("../webhooks.refunds.create");

    const response = await action(
      makeArgs("https://app.example/webhooks/refunds/create"),
    );

    expect(response.status).toBe(200);
    expect(syncItemCreateMock).toHaveBeenCalledExactlyOnceWith({
      data: {
        shop: SHOP,
        shopifyOrderId: "8209829119461545",
        shopifyOrderName: "8209829119461545",
        topic: "refunds/create",
      },
    });
  });
});
