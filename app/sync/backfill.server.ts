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
      // Bare numeric id, matching the format webhook routes store (see webhooks.orders.create.tsx).
      const shopifyOrderId = node.id.replace("gid://shopify/Order/", "");

      const existing = await db.syncItem.findFirst({
        where: { shop, shopifyOrderId, status: { not: "error" } },
      });
      if (existing) continue;

      await db.syncItem.create({
        data: {
          shop,
          shopifyOrderId,
          shopifyOrderName: node.name,
          topic: "backfill",
        },
      });
      enqueued++;
    }

    if (!data.orders.pageInfo.hasNextPage) break;
    const lastEdge = data.orders.edges[data.orders.edges.length - 1];
    if (!lastEdge) break;
    after = lastEdge.cursor;

    if (page === MAX_PAGES - 1) truncated = true;
  }

  return { enqueued, truncated };
}
