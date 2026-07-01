import db from "../db.server";
import { unauthenticated } from "../shopify.server";

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

const ORDERS_FOR_BACKFILL_QUERY = `#graphql
  query OrdersForBackfill($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
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

interface OrdersForBackfillResponse {
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

export async function triggerBackfill(
  shop: string,
  dateFrom: string,
  dateTo: string,
): Promise<{ enqueued: number; truncated: boolean }> {
  const { admin } = await unauthenticated.admin(shop);
  const searchQuery = `created_at:>=${dateFrom} AND created_at:<=${dateTo}`;

  let enqueued = 0;
  let after: string | null = null;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await admin.graphql(ORDERS_FOR_BACKFILL_QUERY, {
      variables: { first: PAGE_SIZE, after, query: searchQuery },
    });
    const { data } = (await response.json()) as OrdersForBackfillResponse;

    for (const { node } of data.orders.edges) {
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

export async function syncSingleOrder(
  shop: string,
  shopifyOrderId: string,
  shopifyOrderName: string,
): Promise<{ enqueued: boolean }> {
  const enqueued = await enqueueBackfillItem(
    shop,
    shopifyOrderId,
    shopifyOrderName,
  );
  return { enqueued };
}

const RECENT_ORDERS_QUERY = `#graphql
  query RecentOrdersForPicker($first: Int!) {
    orders(first: $first, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        displayFinancialStatus
      }
    }
  }
`;

interface RecentOrdersResponse {
  data: {
    orders: {
      nodes: Array<{
        id: string;
        name: string;
        createdAt: string;
        displayFinancialStatus: string | null;
      }>;
    };
  };
}

export interface RecentOrder {
  shopifyOrderId: string;
  shopifyOrderName: string;
  createdAt: string;
  financialStatus: string | null;
}

export async function listRecentOrders(
  shop: string,
  limit = 25,
): Promise<RecentOrder[]> {
  const { admin } = await unauthenticated.admin(shop);
  const response = await admin.graphql(RECENT_ORDERS_QUERY, {
    variables: { first: limit },
  });
  const { data } = (await response.json()) as RecentOrdersResponse;

  return data.orders.nodes.map((node) => ({
    shopifyOrderId: toBareOrderId(node.id),
    shopifyOrderName: node.name,
    createdAt: node.createdAt,
    financialStatus: node.displayFinancialStatus,
  }));
}
