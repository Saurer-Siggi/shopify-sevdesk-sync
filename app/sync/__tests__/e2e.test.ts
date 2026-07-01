import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";

// Fixture-based end-to-end smoke test: webhook delivery -> queue -> worker ->
// SevDesk client, with only the two external boundaries (Shopify Admin API,
// SevDesk API) mocked. Everything in between (Prisma-backed queue, dedup
// logic, topic routing) runs for real. Never touches a live API.

const SHOP = "smoke-test-shop.myshopify.com";
const ORDER_GID = "gid://shopify/Order/900000000001";
const ORDER_NAME = "#9001";

interface FakeSyncItem {
  id: string;
  shop: string;
  shopifyOrderId: string;
  shopifyOrderName: string;
  topic: string;
  status: string;
  attempts: number;
  lastError: string | null;
  sevdeskInvoiceId: string | null;
}

let items: FakeSyncItem[] = [];
let nextId = 1;

const FAKE_SETTINGS = {
  shop: SHOP,
  syncEnabled: true,
  sevdeskContactPersonId: "999",
  sevdeskTaxRuleId: "1",
  sevdeskCategoryId: "3",
  invoiceStatus: "100",
  currency: "EUR",
};

const dbMock = {
  syncSettings: {
    findUnique: vi.fn(async ({ where: { shop } }: { where: { shop: string } }) =>
      shop === SHOP ? FAKE_SETTINGS : null,
    ),
    findMany: vi.fn(async () => [FAKE_SETTINGS]),
  },
  syncItem: {
    create: vi.fn(async ({ data }: { data: Omit<FakeSyncItem, "id" | "status" | "attempts" | "lastError" | "sevdeskInvoiceId"> }) => {
      const row: FakeSyncItem = {
        id: String(nextId++),
        status: "pending",
        attempts: 0,
        lastError: null,
        sevdeskInvoiceId: null,
        ...data,
      };
      items.push(row);
      return row;
    }),
    findMany: vi.fn(
      async ({ where }: { where: { shop: string; status: string } }) =>
        items.filter((i) => i.shop === where.shop && i.status === where.status),
    ),
    update: vi.fn(
      async ({
        where: { id },
        data,
      }: {
        where: { id: string };
        data: Partial<FakeSyncItem> & { attempts?: { increment: number } };
      }) => {
        const row = items.find((i) => i.id === id)!;
        const { attempts, ...rest } = data;
        Object.assign(row, rest);
        if (attempts) row.attempts += attempts.increment;
        return row;
      },
    ),
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
};

vi.mock("../../db.server", () => ({ default: dbMock }));

const authenticateWebhookMock = vi.fn();
vi.mock("../../shopify.server", () => ({
  authenticate: { webhook: authenticateWebhookMock },
  unauthenticated: {
    admin: vi.fn(async () => ({
      admin: {
        graphql: vi.fn(async () => ({
          json: async () => ({
            data: {
              order: {
                id: ORDER_GID,
                name: ORDER_NAME,
                email: "customer@example.invalid",
                displayFinancialStatus: "PENDING",
                currentTotalPriceSet: { shopMoney: { amount: "25.80" } },
                paymentGatewayNames: ["shopify_payments"],
                processedAt: "2026-06-01T10:00:00.000Z",
                customer: {
                  id: "gid://shopify/Customer/1",
                  firstName: "Erika",
                  lastName: "Musterfrau",
                  displayName: "Erika Musterfrau",
                  defaultEmailAddress: { emailAddress: "customer@example.invalid" },
                },
                shippingAddress: {
                  name: "Erika Musterfrau",
                  address1: "Musterstraße 1",
                  zip: "10115",
                  city: "Berlin",
                },
                billingAddress: null,
                lineItems: {
                  nodes: [
                    {
                      title: "Sauren Siggi 0.5l",
                      quantity: 2,
                      originalUnitPriceSet: { shopMoney: { amount: "12.90" } },
                      taxLines: [{ ratePercentage: 19 }],
                    },
                  ],
                },
              },
            },
          }),
        })),
      },
    })),
  },
}));

const findInvoicesByOrderNameMock = vi.fn(
  async (): Promise<{ id: string; invoiceNumber: string }[]> => [],
);
const upsertContactByEmailMock = vi.fn(async () => ({ id: "contact-1" }));
const createInvoiceForOrderMock = vi.fn(async () => ({
  id: "invoice-1",
  invoiceNumber: "RE-2026-0001",
}));
vi.mock("../../sevdesk/client.server", () => ({
  findInvoicesByOrderName: findInvoicesByOrderNameMock,
  upsertContactByEmail: upsertContactByEmailMock,
  createInvoiceForOrder: createInvoiceForOrderMock,
  createCreditNoteForOrder: vi.fn(),
}));

function makeWebhookRequest(): ActionFunctionArgs {
  const url = "https://app.example/webhooks/orders/create";
  return {
    request: new Request(url, { method: "POST" }),
    params: {},
    context: {},
    url: new URL(url),
    pattern: new URL(url).pathname,
  };
}

describe("end-to-end smoke: webhook delivery through to SevDesk invoice", () => {
  beforeEach(() => {
    items = [];
    nextId = 1;
    vi.clearAllMocks();
  });

  it("creates a SevDesk invoice for a new order delivered via webhook", async () => {
    authenticateWebhookMock.mockResolvedValue({
      shop: SHOP,
      topic: "orders/create",
      payload: { id: 900000000001, name: ORDER_NAME },
    });

    const { action } = await import("../../routes/webhooks.orders.create");
    const response = await action(makeWebhookRequest());
    expect(response.status).toBe(200);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("pending");

    const { processQueueOnce } = await import("../worker.server");
    const processed = await processQueueOnce(SHOP);

    expect(processed).toBe(1);
    expect(upsertContactByEmailMock).toHaveBeenCalledOnce();
    expect(createInvoiceForOrderMock).toHaveBeenCalledOnce();
    expect(items[0].status).toBe("success");
    expect(items[0].sevdeskInvoiceId).toBe("invoice-1");
    expect(items[0].shopifyOrderName).toBe(ORDER_NAME);
  });

  it("skips creating a duplicate invoice when SevDesk already has one for the order", async () => {
    findInvoicesByOrderNameMock.mockResolvedValueOnce([
      { id: "existing-invoice", invoiceNumber: "RE-2026-0000" },
    ]);
    authenticateWebhookMock.mockResolvedValue({
      shop: SHOP,
      topic: "orders/create",
      payload: { id: 900000000001, name: ORDER_NAME },
    });

    const { action } = await import("../../routes/webhooks.orders.create");
    await action(makeWebhookRequest());

    const { processQueueOnce } = await import("../worker.server");
    await processQueueOnce(SHOP);

    expect(createInvoiceForOrderMock).not.toHaveBeenCalled();
    expect(items[0].status).toBe("duplicate_skipped");
    expect(items[0].sevdeskInvoiceId).toBe("existing-invoice");
  });
});
