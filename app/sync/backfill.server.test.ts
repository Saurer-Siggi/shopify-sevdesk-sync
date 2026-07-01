import { beforeEach, describe, expect, it, vi } from "vitest";

const graphqlMock = vi.fn();
const unauthenticatedAdminMock = vi.fn();
vi.mock("../shopify.server", () => ({
  unauthenticated: { admin: unauthenticatedAdminMock },
}));

const syncItemFindFirstMock = vi.fn();
const syncItemCreateMock = vi.fn();
vi.mock("../db.server", () => ({
  default: {
    syncItem: { findFirst: syncItemFindFirstMock, create: syncItemCreateMock },
  },
}));

const sevGetMock = vi.fn();
vi.mock("../sevdesk/http.server", () => ({
  sevGet: sevGetMock,
}));

const SHOP = "example.myshopify.com";

function jsonResponse(body: unknown): { json: () => Promise<unknown> } {
  return { json: async () => body };
}

function ordersPage(
  orders: Array<{ id: string; name: string }>,
  hasNextPage: boolean,
) {
  return jsonResponse({
    data: {
      orders: {
        edges: orders.map((node, i) => ({ cursor: `cursor-${i}`, node })),
        pageInfo: { hasNextPage },
      },
    },
  });
}

function recentOrdersPage(
  orders: Array<{
    id: string;
    name: string;
    createdAt: string;
    displayFinancialStatus: string | null;
  }>,
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  },
) {
  return jsonResponse({
    data: {
      orders: {
        nodes: orders,
        pageInfo,
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  unauthenticatedAdminMock.mockResolvedValue({ admin: { graphql: graphqlMock } });
  sevGetMock.mockResolvedValue([]);
});

describe("syncAllUnsynced", () => {
  it("enqueues SyncItem rows for orders not already in SevDesk", async () => {
    graphqlMock.mockResolvedValueOnce(
      ordersPage([{ id: "gid://shopify/Order/1001", name: "#2001" }], false),
    );
    syncItemFindFirstMock.mockResolvedValueOnce(null);
    const { syncAllUnsynced } = await import("./backfill.server");

    const result = await syncAllUnsynced(SHOP);

    expect(syncItemCreateMock).toHaveBeenCalledExactlyOnceWith({
      data: {
        shop: SHOP,
        shopifyOrderId: "1001",
        shopifyOrderName: "#2001",
        topic: "backfill",
      },
    });
    expect(result).toEqual({ enqueued: 1, truncated: false });
  });

  it("skips orders already present in SevDesk", async () => {
    graphqlMock.mockResolvedValueOnce(
      ordersPage([{ id: "gid://shopify/Order/1002", name: "#2002" }], false),
    );
    sevGetMock.mockResolvedValueOnce([{ customerInternalNote: "#2002" }]);
    const { syncAllUnsynced } = await import("./backfill.server");

    const result = await syncAllUnsynced(SHOP);

    expect(syncItemFindFirstMock).not.toHaveBeenCalled();
    expect(syncItemCreateMock).not.toHaveBeenCalled();
    expect(result).toEqual({ enqueued: 0, truncated: false });
  });

  it("skips orders that already have a non-error SyncItem row", async () => {
    graphqlMock.mockResolvedValueOnce(
      ordersPage([{ id: "gid://shopify/Order/1003", name: "#2003" }], false),
    );
    syncItemFindFirstMock.mockResolvedValueOnce({
      id: "existing-1",
      status: "success",
    });
    const { syncAllUnsynced } = await import("./backfill.server");

    const result = await syncAllUnsynced(SHOP);

    expect(syncItemCreateMock).not.toHaveBeenCalled();
    expect(result).toEqual({ enqueued: 0, truncated: false });
  });

  it("pages through results until hasNextPage is false", async () => {
    graphqlMock
      .mockResolvedValueOnce(
        ordersPage([{ id: "gid://shopify/Order/2001", name: "#3001" }], true),
      )
      .mockResolvedValueOnce(
        ordersPage([{ id: "gid://shopify/Order/2002", name: "#3002" }], false),
      );
    syncItemFindFirstMock.mockResolvedValue(null);
    const { syncAllUnsynced } = await import("./backfill.server");

    const result = await syncAllUnsynced(SHOP);

    expect(graphqlMock).toHaveBeenCalledTimes(2);
    const secondCallVariables = graphqlMock.mock.calls[1][1] as {
      variables: { after: string | null };
    };
    expect(secondCallVariables.variables.after).toBe("cursor-0");
    expect(result).toEqual({ enqueued: 2, truncated: false });
  });

  it("reports truncated when the page cap is hit before pagination ends", async () => {
    graphqlMock.mockImplementation(() =>
      Promise.resolve(
        ordersPage([{ id: "gid://shopify/Order/9999", name: "#9999" }], true),
      ),
    );
    syncItemFindFirstMock.mockResolvedValue(null);
    const { syncAllUnsynced } = await import("./backfill.server");

    const result = await syncAllUnsynced(SHOP);

    expect(result.truncated).toBe(true);
  });
});

describe("syncOrders", () => {
  it("enqueues each given order and returns the count actually enqueued", async () => {
    syncItemFindFirstMock.mockResolvedValue(null);
    const { syncOrders } = await import("./backfill.server");

    const result = await syncOrders(SHOP, [
      { shopifyOrderId: "1001", shopifyOrderName: "#2001" },
      { shopifyOrderId: "1002", shopifyOrderName: "#2002" },
    ]);

    expect(syncItemCreateMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ enqueued: 2 });
  });

  it("skips orders that already have a non-error SyncItem row", async () => {
    syncItemFindFirstMock
      .mockResolvedValueOnce({ id: "existing-1", status: "success" })
      .mockResolvedValueOnce(null);
    const { syncOrders } = await import("./backfill.server");

    const result = await syncOrders(SHOP, [
      { shopifyOrderId: "1001", shopifyOrderName: "#2001" },
      { shopifyOrderId: "1002", shopifyOrderName: "#2002" },
    ]);

    expect(syncItemCreateMock).toHaveBeenCalledExactlyOnceWith({
      data: {
        shop: SHOP,
        shopifyOrderId: "1002",
        shopifyOrderName: "#2002",
        topic: "backfill",
      },
    });
    expect(result).toEqual({ enqueued: 1 });
  });
});

describe("listOrders", () => {
  const PAGE_INFO = {
    hasNextPage: true,
    hasPreviousPage: false,
    startCursor: "start-1",
    endCursor: "end-1",
  };

  it("requests a forward page by default and marks orders found in SevDesk", async () => {
    graphqlMock.mockResolvedValueOnce(
      recentOrdersPage(
        [
          {
            id: "gid://shopify/Order/1001",
            name: "#1001",
            createdAt: "2026-06-01T00:00:00Z",
            displayFinancialStatus: "PAID",
          },
          {
            id: "gid://shopify/Order/1002",
            name: "#1002",
            createdAt: "2026-06-02T00:00:00Z",
            displayFinancialStatus: "PAID",
          },
        ],
        PAGE_INFO,
      ),
    );
    sevGetMock.mockResolvedValueOnce([
      { customerInternalNote: "#1001" },
      { customerInternalNote: null },
    ]);
    const { listOrders } = await import("./backfill.server");

    const result = await listOrders(SHOP);

    expect(graphqlMock).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("OrdersForward"),
      { variables: { first: 25, after: null } },
    );
    expect(result.orders).toEqual([
      {
        shopifyOrderId: "1001",
        shopifyOrderName: "#1001",
        createdAt: "2026-06-01T00:00:00Z",
        financialStatus: "PAID",
        alreadyInSevDesk: true,
      },
      {
        shopifyOrderId: "1002",
        shopifyOrderName: "#1002",
        createdAt: "2026-06-02T00:00:00Z",
        financialStatus: "PAID",
        alreadyInSevDesk: false,
      },
    ]);
    expect(result.pageInfo).toEqual(PAGE_INFO);
  });

  it("uses the backward query with last/before when a before cursor is given", async () => {
    graphqlMock.mockResolvedValueOnce(recentOrdersPage([], PAGE_INFO));
    const { listOrders } = await import("./backfill.server");

    await listOrders(SHOP, { before: "cursor-abc", pageSize: 10 });

    expect(graphqlMock).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("OrdersBackward"),
      { variables: { last: 10, before: "cursor-abc" } },
    );
  });

  it("uses the forward query with first/after when an after cursor is given", async () => {
    graphqlMock.mockResolvedValueOnce(recentOrdersPage([], PAGE_INFO));
    const { listOrders } = await import("./backfill.server");

    await listOrders(SHOP, { after: "cursor-xyz" });

    expect(graphqlMock).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("OrdersForward"),
      { variables: { first: 25, after: "cursor-xyz" } },
    );
  });

  it("fetches SevDesk invoices once via a bulk lookup, not per order", async () => {
    graphqlMock.mockResolvedValueOnce(
      recentOrdersPage(
        [
          {
            id: "gid://shopify/Order/1",
            name: "#1",
            createdAt: "2026-06-01T00:00:00Z",
            displayFinancialStatus: "PAID",
          },
          {
            id: "gid://shopify/Order/2",
            name: "#2",
            createdAt: "2026-06-02T00:00:00Z",
            displayFinancialStatus: "PAID",
          },
        ],
        PAGE_INFO,
      ),
    );
    sevGetMock.mockResolvedValueOnce([]);
    const { listOrders } = await import("./backfill.server");

    await listOrders(SHOP);

    expect(sevGetMock).toHaveBeenCalledTimes(1);
    expect(sevGetMock).toHaveBeenCalledWith(
      "/Invoice",
      expect.objectContaining({ limit: expect.any(String) }),
    );
  });
});
