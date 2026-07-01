import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

const authenticateAdminMock = vi.fn();
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateAdminMock },
}));

const syncSettingsUpsertMock = vi.fn();
const paymentAccountMappingFindManyMock = vi.fn();
const paymentAccountMappingUpsertMock = vi.fn();
const paymentAccountMappingDeleteManyMock = vi.fn();
vi.mock("../../db.server", () => ({
  default: {
    syncSettings: {
      upsert: syncSettingsUpsertMock,
    },
    paymentAccountMapping: {
      findMany: paymentAccountMappingFindManyMock,
      upsert: paymentAccountMappingUpsertMock,
      deleteMany: paymentAccountMappingDeleteManyMock,
    },
  },
}));

const listSevUsersMock = vi.fn();
const listTaxRulesMock = vi.fn();
const listCheckAccountsMock = vi.fn();
vi.mock("../../sevdesk/client.server", () => ({
  listSevUsers: listSevUsersMock,
  listTaxRules: listTaxRulesMock,
  listCheckAccounts: listCheckAccountsMock,
}));

const SHOP = "example.myshopify.com";

function makeLoaderArgs(): LoaderFunctionArgs {
  const request = new Request("https://app.example/app/settings");
  return { request, params: {}, context: {} } as LoaderFunctionArgs;
}

function makeActionArgs(formData: Record<string, string>): ActionFunctionArgs {
  const body = new URLSearchParams(formData);
  const request = new Request("https://app.example/app/settings", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return { request, params: {}, context: {} } as ActionFunctionArgs;
}

describe("app.settings loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateAdminMock.mockResolvedValue({
      session: { shop: SHOP },
      admin: {
        graphql: vi.fn().mockResolvedValue({
          json: () =>
            Promise.resolve({ data: { shop: { currencyCode: "EUR" } } }),
        }),
      },
    });
    syncSettingsUpsertMock.mockResolvedValue({
      shop: SHOP,
      sevdeskContactPersonId: null,
      sevdeskTaxRuleId: null,
      sevdeskCategoryId: null,
      invoiceStatus: null,
      currency: null,
      defaultCheckAccountId: null,
    });
    paymentAccountMappingFindManyMock.mockResolvedValue([]);
    listSevUsersMock.mockResolvedValue([]);
    listTaxRulesMock.mockResolvedValue([]);
    listCheckAccountsMock.mockResolvedValue([]);
  });

  it("returns check accounts, existing mappings, and default check account", async () => {
    listCheckAccountsMock.mockResolvedValue([
      { id: "1", name: "FYRST BASE" },
      { id: "2", name: "PayPal" },
    ]);
    paymentAccountMappingFindManyMock.mockResolvedValue([
      { id: "m1", shop: SHOP, gatewayName: "paypal", checkAccountId: "2" },
    ]);
    syncSettingsUpsertMock.mockResolvedValue({
      shop: SHOP,
      sevdeskContactPersonId: null,
      sevdeskTaxRuleId: null,
      sevdeskCategoryId: null,
      invoiceStatus: null,
      currency: null,
      defaultCheckAccountId: "1",
    });
    const { loader } = await import("../app.settings");

    const result = await loader(makeLoaderArgs());

    expect(paymentAccountMappingFindManyMock).toHaveBeenCalledExactlyOnceWith({
      where: { shop: SHOP },
    });
    expect(result.checkAccounts).toEqual([
      { id: "1", name: "FYRST BASE" },
      { id: "2", name: "PayPal" },
    ]);
    expect(result.paymentAccountMappings).toEqual([
      { id: "m1", shop: SHOP, gatewayName: "paypal", checkAccountId: "2" },
    ]);
    expect(result.defaultCheckAccountId).toBe("1");
    expect(result.sevdeskLoadError).toBe(false);
  });

  it("sets sevdeskLoadError when listCheckAccounts fails, alongside the other live lookups", async () => {
    listCheckAccountsMock.mockRejectedValue(new Error("network error"));
    const { loader } = await import("../app.settings");

    const result = await loader(makeLoaderArgs());

    expect(result.sevdeskLoadError).toBe(true);
    expect(result.checkAccounts).toEqual([]);
  });
});

describe("app.settings action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateAdminMock.mockResolvedValue({ session: { shop: SHOP } });
    syncSettingsUpsertMock.mockResolvedValue({ shop: SHOP });
    paymentAccountMappingUpsertMock.mockResolvedValue({});
    paymentAccountMappingDeleteManyMock.mockResolvedValue({ count: 0 });
  });

  it("upserts a mapping when a check account is submitted for a gateway", async () => {
    const { action } = await import("../app.settings");

    await action(
      makeActionArgs({
        intent: "save",
        invoiceStatus: "100",
        checkAccount_paypal: "2",
      }),
    );

    expect(paymentAccountMappingUpsertMock).toHaveBeenCalledWith({
      where: { shop_gatewayName: { shop: SHOP, gatewayName: "paypal" } },
      update: { checkAccountId: "2" },
      create: { shop: SHOP, gatewayName: "paypal", checkAccountId: "2" },
    });
  });

  it("deletes a mapping row when the field is submitted blank", async () => {
    const { action } = await import("../app.settings");

    await action(
      makeActionArgs({
        intent: "save",
        invoiceStatus: "100",
        checkAccount_shopify_payments: "",
      }),
    );

    expect(paymentAccountMappingDeleteManyMock).toHaveBeenCalledWith({
      where: { shop: SHOP, gatewayName: "shopify_payments" },
    });
    expect(paymentAccountMappingUpsertMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ gatewayName: "shopify_payments" }),
      }),
    );
  });

  it("persists defaultCheckAccountId on SyncSettings", async () => {
    const { action } = await import("../app.settings");

    await action(
      makeActionArgs({
        intent: "save",
        invoiceStatus: "1000",
        defaultCheckAccountId: "1",
      }),
    );

    expect(syncSettingsUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shop: SHOP },
        update: expect.objectContaining({ defaultCheckAccountId: "1" }),
        create: expect.objectContaining({ defaultCheckAccountId: "1" }),
      }),
    );
  });
});
