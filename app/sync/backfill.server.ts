import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { sevGet } from "../sevdesk/http.server";

const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const DEFAULT_ORDERS_PAGE_SIZE = 25;
const INVOICED_ORDER_NAMES_LIMIT = 500;

const ORDERS_FOR_SYNC_ALL_QUERY = `#graphql
  query OrdersForSyncAll($first: Int!, $after: String) {
    orders(first: $first, after: $after, sortKey: CREATED_AT, query: "status:any") {
      edges {
        cursor
        node {
          id
          name
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

interface OrdersForSyncAllResponse {
  data: {
    orders: {
      edges: Array<{ cursor: string; node: { id: string; name: string } }>;
      pageInfo: { hasNextPage: boolean };
    };
  };
}

function toBareOrderId(gid: string): string {
  // Bare numeric id, matching the format webhook routes store (see webhooks.orders.create.tsx).
  return gid.replace("gid://shopify/Order/", "");
}

async function enqueueBackfillItem(
  shop: string,
  shopifyOrderId: string,
  shopifyOrderName: string,
): Promise<boolean> {
  const existing = await db.syncItem.findFirst({
    where: { shop, shopifyOrderId, status: { not: "error" } },
  });
  if (existing) return false;

  await db.syncItem.create({
    data: { shop, shopifyOrderId, shopifyOrderName, topic: "backfill" },
  });
  return true;
}

interface RawInvoiceNote {
  customerInternalNote?: string | null;
}

// Bulk fetch instead of one findInvoicesByOrderName call per displayed order —
// avoids N+1 live SevDesk requests on every admin page load.
async function fetchInvoicedOrderNames(
  limit = INVOICED_ORDER_NAMES_LIMIT,
): Promise<Set<string>> {
  const invoices = await sevGet<RawInvoiceNote>("/Invoice", {
    limit: String(limit),
    orderBy: "invoiceDate DESC",
  });
  const names = new Set<string>();
  for (const invoice of invoices) {
    if (invoice.customerInternalNote) names.add(invoice.customerInternalNote);
  }
  return names;
}

export async function syncAllUnsynced(
  shop: string,
): Promise<{ enqueued: number; truncated: boolean }> {
  const { admin } = await unauthenticated.admin(shop);
  const invoicedNames = await fetchInvoicedOrderNames();

  let enqueued = 0;
  let after: string | null = null;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await admin.graphql(ORDERS_FOR_SYNC_ALL_QUERY, {
      variables: { first: PAGE_SIZE, after },
    });
    const { data } = (await response.json()) as OrdersForSyncAllResponse;

    for (const { node } of data.orders.edges) {
      if (invoicedNames.has(node.name)) continue;
      const didEnqueue = await enqueueBackfillItem(
        shop,
        toBareOrderId(node.id),
        node.name,
      );
      if (didEnqueue) enqueued++;
    }

    if (!data.orders.pageInfo.hasNextPage) break;
    const lastEdge = data.orders.edges[data.orders.edges.length - 1];
    if (!lastEdge) break;
    after = lastEdge.cursor;

    if (page === MAX_PAGES - 1) truncated = true;
  }

  return { enqueued, truncated };
}

export async function syncOrders(
  shop: string,
  orders: Array<{ shopifyOrderId: string; shopifyOrderName: string }>,
): Promise<{ enqueued: number }> {
  let enqueued = 0;
  for (const { shopifyOrderId, shopifyOrderName } of orders) {
    const didEnqueue = await enqueueBackfillItem(
      shop,
      shopifyOrderId,
      shopifyOrderName,
    );
    if (didEnqueue) enqueued++;
  }
  return { enqueued };
}

const ORDERS_FORWARD_QUERY = `#graphql
  query OrdersForward($first: Int!, $after: String) {
    orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true, query: "status:any") {
      nodes {
        id
        name
        createdAt
        displayFinancialStatus
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`;

const ORDERS_BACKWARD_QUERY = `#graphql
  query OrdersBackward($last: Int!, $before: String) {
    orders(last: $last, before: $before, sortKey: CREATED_AT, reverse: true, query: "status:any") {
      nodes {
        id
        name
        createdAt
        displayFinancialStatus
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`;

interface OrdersPageResponse {
  data: {
    orders: {
      nodes: Array<{
        id: string;
        name: string;
        createdAt: string;
        displayFinancialStatus: string | null;
      }>;
      pageInfo: {
        hasNextPage: boolean;
        hasPreviousPage: boolean;
        startCursor: string | null;
        endCursor: string | null;
      };
    };
  };
}

export interface ShopifyOrder {
  shopifyOrderId: string;
  shopifyOrderName: string;
  createdAt: string;
  financialStatus: string | null;
  alreadyInSevDesk: boolean;
}

export interface OrdersPage {
  orders: ShopifyOrder[];
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
}

export async function listOrders(
  shop: string,
  options?: { after?: string; before?: string; pageSize?: number },
): Promise<OrdersPage> {
  const pageSize = options?.pageSize ?? DEFAULT_ORDERS_PAGE_SIZE;
  const { admin } = await unauthenticated.admin(shop);

  const [response, invoicedNames] = await Promise.all([
    options?.before
      ? admin.graphql(ORDERS_BACKWARD_QUERY, {
          variables: { last: pageSize, before: options.before },
        })
      : admin.graphql(ORDERS_FORWARD_QUERY, {
          variables: { first: pageSize, after: options?.after ?? null },
        }),
    fetchInvoicedOrderNames(),
  ]);
  const { data } = (await response.json()) as OrdersPageResponse;

  return {
    orders: data.orders.nodes.map((node) => ({
      shopifyOrderId: toBareOrderId(node.id),
      shopifyOrderName: node.name,
      createdAt: node.createdAt,
      financialStatus: node.displayFinancialStatus,
      alreadyInSevDesk: invoicedNames.has(node.name),
    })),
    pageInfo: data.orders.pageInfo,
  };
}
