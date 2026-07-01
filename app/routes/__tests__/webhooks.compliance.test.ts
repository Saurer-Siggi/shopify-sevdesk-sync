import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";

const authenticateWebhookMock = vi.fn();
vi.mock("../../shopify.server", () => ({
  authenticate: { webhook: authenticateWebhookMock },
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

describe("compliance webhooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["customers/data_request", "customers/redact", "shop/redact"])(
    "acknowledges %s with a 200 and no data handling",
    async (topic) => {
      authenticateWebhookMock.mockResolvedValue({
        shop: SHOP,
        topic,
        payload: { shop_id: 954889, shop_domain: SHOP },
      });
      const { action } = await import("../webhooks.compliance");

      const response = await action(
        makeArgs("https://app.example/webhooks/compliance"),
      );

      expect(response.status).toBe(200);
    },
  );
});
