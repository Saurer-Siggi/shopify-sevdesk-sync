import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncItem } from "@prisma/client";

const findInvoicesByOrderNameMock = vi.fn();
const upsertContactByEmailMock = vi.fn();
const createInvoiceForOrderMock = vi.fn();
const createCreditNoteForOrderMock = vi.fn();
vi.mock("../sevdesk/client.server", () => ({
  findInvoicesByOrderName: findInvoicesByOrderNameMock,
  upsertContactByEmail: upsertContactByEmailMock,
  createInvoiceForOrder: createInvoiceForOrderMock,
  createCreditNoteForOrder: createCreditNoteForOrderMock,
}));

const graphqlMock = vi.fn();
const unauthenticatedAdminMock = vi.fn();
vi.mock("../shopify.server", () => ({
  unauthenticated: { admin: unauthenticatedAdminMock },
}));

const syncItemUpdateMock = vi.fn();
vi.mock("../db.server", () => ({
  default: {
    syncItem: { update: syncItemUpdateMock },
  },
}));

const SHOP = "example.myshopify.com";

function jsonResponse(body: unknown): { json: () => Promise<unknown> } {
  return { json: async () => body };
}

function makeOrderResponse(overrides: {
  name?: string;
  email?: string | null;
  customerEmail?: string | null;
} = {}) {
  return jsonResponse({
    data: {
      order: {
        id: "gid://shopify/Order/1050",
        name: overrides.name ?? "#1050",
        email: overrides.email ?? null,
        customer: {
          id: "gid://shopify/Customer/1",
          firstName: "Max",
          lastName: "Mustermann",
          displayName: "Max Mustermann",
          defaultEmailAddress:
            overrides.customerEmail === undefined
              ? { emailAddress: "test@example.invalid" }
              : overrides.customerEmail
                ? { emailAddress: overrides.customerEmail }
                : null,
        },
        lineItems: {
          nodes: [
            {
              title: "Sauerkirsch Likör 0.5l",
              quantity: 2,
              originalUnitPriceSet: { shopMoney: { amount: "12.50" } },
              taxLines: [{ ratePercentage: 19 }],
            },
          ],
        },
      },
    },
  });
}

function makeSyncItem(overrides: Partial<SyncItem> = {}): SyncItem {
  return {
    id: "item-1",
    shop: SHOP,
    shopifyOrderId: "1050",
    shopifyOrderName: "#1050",
    topic: "orders/create",
    status: "processing",
    attempts: 0,
    lastError: null,
    sevdeskInvoiceId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  unauthenticatedAdminMock.mockResolvedValue({ admin: { graphql: graphqlMock } });
});

describe("processSyncItem — invoice topics", () => {
  it("skips as duplicate when an invoice already exists", async () => {
    graphqlMock.mockResolvedValueOnce(makeOrderResponse());
    findInvoicesByOrderNameMock.mockResolvedValueOnce([
      { id: "sd-1", invoiceNumber: "RN-2026-0001" },
    ]);
    const { processSyncItem } = await import("./processor.server");

    await processSyncItem(makeSyncItem());

    expect(upsertContactByEmailMock).not.toHaveBeenCalled();
    expect(createInvoiceForOrderMock).not.toHaveBeenCalled();
    expect(syncItemUpdateMock).toHaveBeenCalledExactlyOnceWith({
      where: { id: "item-1" },
      data: {
        status: "duplicate_skipped",
        sevdeskInvoiceId: "sd-1",
        shopifyOrderName: "#1050",
      },
    });
  });

  it("creates a contact and invoice when no match exists", async () => {
    graphqlMock.mockResolvedValueOnce(makeOrderResponse());
    findInvoicesByOrderNameMock.mockResolvedValueOnce([]);
    upsertContactByEmailMock.mockResolvedValueOnce({ id: "contact-1" });
    createInvoiceForOrderMock.mockResolvedValueOnce({
      id: "sd-invoice-1",
      invoiceNumber: "RN-2026-0002",
    });
    const { processSyncItem } = await import("./processor.server");

    await processSyncItem(makeSyncItem());

    expect(upsertContactByEmailMock).toHaveBeenCalledExactlyOnceWith({
      email: "test@example.invalid",
      firstName: "Max",
      lastName: "Mustermann",
    });
    expect(createInvoiceForOrderMock).toHaveBeenCalledExactlyOnceWith({
      orderName: "#1050",
      contactId: "contact-1",
      invoiceDate: expect.any(Date),
      lineItems: [
        {
          name: "Sauerkirsch Likör 0.5l",
          quantity: 2,
          unitPriceGross: 12.5,
          taxRatePercent: 19,
        },
      ],
    });
    expect(syncItemUpdateMock).toHaveBeenCalledExactlyOnceWith({
      where: { id: "item-1" },
      data: {
        status: "success",
        sevdeskInvoiceId: "sd-invoice-1",
        shopifyOrderName: "#1050",
      },
    });
  });
});

describe("processSyncItem — credit note topics", () => {
  it("creates a credit note when a matching invoice exists", async () => {
    graphqlMock.mockResolvedValueOnce(makeOrderResponse({ name: "#1051" }));
    findInvoicesByOrderNameMock.mockResolvedValueOnce([
      { id: "sd-1", invoiceNumber: "RN-2026-0003" },
    ]);
    upsertContactByEmailMock.mockResolvedValueOnce({ id: "contact-1" });
    createCreditNoteForOrderMock.mockResolvedValueOnce({ id: "sd-credit-1" });
    const { processSyncItem } = await import("./processor.server");

    await processSyncItem(
      makeSyncItem({ topic: "orders/cancelled", shopifyOrderName: "#1051" }),
    );

    expect(createCreditNoteForOrderMock).toHaveBeenCalledExactlyOnceWith({
      orderName: "#1051",
      contactId: "contact-1",
      relatedInvoiceId: "sd-1",
      creditNoteDate: expect.any(Date),
      lineItems: [
        {
          name: "Sauerkirsch Likör 0.5l",
          quantity: 2,
          unitPriceGross: 12.5,
          taxRatePercent: 19,
        },
      ],
    });
    expect(syncItemUpdateMock).toHaveBeenCalledExactlyOnceWith({
      where: { id: "item-1" },
      data: {
        status: "success",
        sevdeskInvoiceId: "sd-credit-1",
        shopifyOrderName: "#1051",
      },
    });
  });

  it("skips with no SevDesk write when no invoice exists yet", async () => {
    graphqlMock.mockResolvedValueOnce(makeOrderResponse({ name: "#1052" }));
    findInvoicesByOrderNameMock.mockResolvedValueOnce([]);
    const { processSyncItem } = await import("./processor.server");

    await processSyncItem(
      makeSyncItem({
        topic: "refunds/create",
        shopifyOrderId: "6009900001",
        shopifyOrderName: "6009900001",
      }),
    );

    expect(upsertContactByEmailMock).not.toHaveBeenCalled();
    expect(createCreditNoteForOrderMock).not.toHaveBeenCalled();
    expect(syncItemUpdateMock).toHaveBeenCalledExactlyOnceWith({
      where: { id: "item-1" },
      data: {
        status: "skipped_no_invoice",
        shopifyOrderName: "#1052",
      },
    });
  });

  it("resolves the real order name instead of the refunds/create placeholder", async () => {
    graphqlMock.mockResolvedValueOnce(makeOrderResponse({ name: "#1099" }));
    findInvoicesByOrderNameMock.mockResolvedValueOnce([
      { id: "sd-9", invoiceNumber: "RN-2026-0099" },
    ]);
    upsertContactByEmailMock.mockResolvedValueOnce({ id: "contact-9" });
    createCreditNoteForOrderMock.mockResolvedValueOnce({ id: "sd-credit-9" });
    const { processSyncItem } = await import("./processor.server");

    const placeholderId = "6009900099";
    await processSyncItem(
      makeSyncItem({
        topic: "refunds/create",
        shopifyOrderId: placeholderId,
        shopifyOrderName: placeholderId,
      }),
    );

    expect(findInvoicesByOrderNameMock).toHaveBeenCalledExactlyOnceWith(
      "#1099",
    );
    expect(createCreditNoteForOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderName: "#1099" }),
    );
    expect(syncItemUpdateMock).toHaveBeenCalledExactlyOnceWith({
      where: { id: "item-1" },
      data: {
        status: "success",
        sevdeskInvoiceId: "sd-credit-9",
        shopifyOrderName: "#1099",
      },
    });
  });
});

describe("processSyncItem — error handling", () => {
  it("records a truncated, PII-free error and increments attempts on failure", async () => {
    graphqlMock.mockResolvedValueOnce(makeOrderResponse());
    findInvoicesByOrderNameMock.mockResolvedValueOnce([]);
    upsertContactByEmailMock.mockRejectedValueOnce(
      new Error("SevDesk API returned 500"),
    );
    const { processSyncItem } = await import("./processor.server");

    await processSyncItem(makeSyncItem({ attempts: 2 }));

    expect(syncItemUpdateMock).toHaveBeenCalledExactlyOnceWith({
      where: { id: "item-1" },
      data: {
        attempts: { increment: 1 },
        status: "error",
        lastError: "SevDesk API returned 500",
        shopifyOrderName: "#1050",
      },
    });
  });

  it("throws a descriptive error and skips SevDesk writes when the order is missing", async () => {
    graphqlMock.mockResolvedValueOnce(jsonResponse({ data: { order: null } }));
    const { processSyncItem } = await import("./processor.server");

    await processSyncItem(makeSyncItem());

    expect(findInvoicesByOrderNameMock).not.toHaveBeenCalled();
    expect(syncItemUpdateMock).toHaveBeenCalledExactlyOnceWith({
      where: { id: "item-1" },
      data: {
        attempts: { increment: 1 },
        status: "error",
        lastError: expect.stringContaining("1050"),
      },
    });
  });

  it("throws on an unknown topic without writing to SevDesk", async () => {
    graphqlMock.mockResolvedValueOnce(makeOrderResponse());
    findInvoicesByOrderNameMock.mockResolvedValueOnce([]);
    const { processSyncItem } = await import("./processor.server");

    await processSyncItem(makeSyncItem({ topic: "orders/updated" }));

    expect(upsertContactByEmailMock).not.toHaveBeenCalled();
    expect(syncItemUpdateMock).toHaveBeenCalledExactlyOnceWith({
      where: { id: "item-1" },
      data: {
        attempts: { increment: 1 },
        status: "error",
        lastError: expect.stringContaining("orders/updated"),
        shopifyOrderName: "#1050",
      },
    });
  });
});
