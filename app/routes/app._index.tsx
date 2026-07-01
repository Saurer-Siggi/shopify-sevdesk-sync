import { useMemo, useState, useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  listOrders,
  syncAllUnsynced,
  syncOrders,
} from "../sync/backfill.server";

const STATUSES = [
  "pending",
  "processing",
  "success",
  "duplicate_skipped",
  "skipped_no_invoice",
  "error",
] as const;

type StatusCounts = Record<(typeof STATUSES)[number], number>;

const BADGE_TONE: Record<
  (typeof STATUSES)[number],
  "info" | "success" | "neutral" | "warning" | "critical"
> = {
  pending: "info",
  processing: "info",
  success: "success",
  duplicate_skipped: "neutral",
  skipped_no_invoice: "warning",
  error: "critical",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await db.syncSettings.upsert({
    where: { shop },
    update: {},
    create: { shop, syncEnabled: false },
  });

  const items = await db.syncItem.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });

  const grouped = await db.syncItem.groupBy({
    by: ["status"],
    where: { shop },
    _count: { status: true },
  });

  const statusCounts = STATUSES.reduce((acc, status) => {
    acc[status] =
      grouped.find((g) => g.status === status)?._count.status ?? 0;
    return acc;
  }, {} as StatusCounts);

  const url = new URL(request.url);
  const after = url.searchParams.get("after") ?? undefined;
  const before = url.searchParams.get("before") ?? undefined;
  const ordersPage = await listOrders(shop, { after, before });
  const coverage = await db.syncItem.findMany({
    where: {
      shop,
      shopifyOrderId: {
        in: ordersPage.orders.map((o) => o.shopifyOrderId),
      },
    },
    orderBy: { updatedAt: "desc" },
  });
  const orders = ordersPage.orders.map((order) => ({
    ...order,
    // Local queue status only — SevDesk's own dedup check (alreadyInSevDesk) is authoritative.
    syncStatus:
      coverage.find((c) => c.shopifyOrderId === order.shopifyOrderId)
        ?.status ?? null,
  }));

  return {
    syncEnabled: settings.syncEnabled,
    items,
    statusCounts,
    orders,
    pageInfo: ordersPage.pageInfo,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "toggle") {
    const current = await db.syncSettings.upsert({
      where: { shop },
      update: {},
      create: { shop, syncEnabled: false },
    });
    const updated = await db.syncSettings.update({
      where: { shop },
      data: { syncEnabled: !current.syncEnabled },
    });
    return { intent, syncEnabled: updated.syncEnabled };
  }

  if (intent === "sync-all-unsynced") {
    const { enqueued, truncated } = await syncAllUnsynced(shop);
    return { intent, enqueued, truncated };
  }

  if (intent === "sync-selected") {
    const orders = JSON.parse(
      String(formData.get("orders") ?? "[]"),
    ) as Array<{ shopifyOrderId: string; shopifyOrderName: string }>;
    const { enqueued } = await syncOrders(shop, orders);
    return { intent, enqueued };
  }

  if (intent === "retry") {
    const itemId = String(formData.get("itemId") ?? "");
    const result = await db.syncItem.updateMany({
      where: { id: itemId, shop, status: "error" },
      data: { status: "pending", lastError: null },
    });
    return { intent, retried: result.count > 0 };
  }

  throw new Response("Unknown intent", { status: 400 });
};

type OrderRow = ReturnType<typeof useLoaderData<typeof loader>>["orders"][number];
type SortColumn =
  | "shopifyOrderName"
  | "createdAt"
  | "financialStatus"
  | "alreadyInSevDesk"
  | "syncStatus";
type SortDirection = "asc" | "desc";

const COLUMN_LABELS: Record<SortColumn, string> = {
  shopifyOrderName: "Order",
  createdAt: "Date",
  financialStatus: "Financial status",
  alreadyInSevDesk: "SevDesk status",
  syncStatus: "Queue status",
};

function compareOrders(
  a: OrderRow,
  b: OrderRow,
  column: SortColumn,
  direction: SortDirection,
): number {
  const aValue = a[column];
  const bValue = b[column];
  let result: number;
  if (typeof aValue === "boolean" || typeof bValue === "boolean") {
    result = Number(aValue) - Number(bValue);
  } else {
    result = String(aValue ?? "").localeCompare(String(bValue ?? ""));
  }
  return direction === "asc" ? result : -result;
}

export default function Index() {
  const { syncEnabled, items, statusCounts, orders, pageInfo } =
    useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const navigate = useNavigate();

  const toggleFetcher = useFetcher<typeof action>();
  const syncAllFetcher = useFetcher<typeof action>();
  const retryFetcher = useFetcher<typeof action>();
  const syncSelectedFetcher = useFetcher<typeof action>();

  const isToggling = toggleFetcher.state !== "idle";
  const isSyncingAll = syncAllFetcher.state !== "idle";
  const isSyncingSelected = syncSelectedFetcher.state !== "idle";

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sortColumn, setSortColumn] = useState<SortColumn>("createdAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  const sortedOrders = useMemo(
    () =>
      [...orders].sort((a, b) =>
        compareOrders(a, b, sortColumn, sortDirection),
      ),
    [orders, sortColumn, sortDirection],
  );

  const optimisticSyncEnabled =
    toggleFetcher.formData?.get("intent") === "toggle"
      ? !syncEnabled
      : syncEnabled;

  useEffect(() => {
    if (syncAllFetcher.data?.intent === "sync-all-unsynced") {
      const { enqueued, truncated } = syncAllFetcher.data;
      shopify.toast.show(
        truncated
          ? `Synced ${enqueued} unsynced order(s) but hit the page limit — some older orders may not have been scanned`
          : `Synced ${enqueued} unsynced order(s)`,
        truncated ? { isError: true } : undefined,
      );
    }
  }, [syncAllFetcher.data, shopify]);

  useEffect(() => {
    if (retryFetcher.data?.intent === "retry") {
      shopify.toast.show(
        retryFetcher.data.retried ? "Retry queued" : "Retry failed",
      );
    }
  }, [retryFetcher.data, shopify]);

  useEffect(() => {
    if (syncSelectedFetcher.data?.intent === "sync-selected") {
      shopify.toast.show(
        `${syncSelectedFetcher.data.enqueued} order(s) queued for sync`,
      );
      setSelectedIds([]);
    }
  }, [syncSelectedFetcher.data, shopify]);

  const toggleSync = () => {
    toggleFetcher.submit({ intent: "toggle" }, { method: "POST" });
  };

  const syncAllUnsyncedOrders = () => {
    syncAllFetcher.submit({ intent: "sync-all-unsynced" }, { method: "POST" });
  };

  const syncSelectedOrders = () => {
    const selected = sortedOrders
      .filter((order) => selectedIds.includes(order.shopifyOrderId))
      .map((order) => ({
        shopifyOrderId: order.shopifyOrderId,
        shopifyOrderName: order.shopifyOrderName,
      }));
    syncSelectedFetcher.submit(
      { intent: "sync-selected", orders: JSON.stringify(selected) },
      { method: "POST" },
    );
  };

  const retryItem = (itemId: string) => {
    retryFetcher.submit({ intent: "retry", itemId }, { method: "POST" });
  };

  const toggleSort = (column: SortColumn) => {
    if (column === sortColumn) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  };

  const columnHeader = (column: SortColumn) =>
    `${COLUMN_LABELS[column]}${
      sortColumn === column ? (sortDirection === "asc" ? " ▲" : " ▼") : ""
    }`;

  const toggleRowSelected = (shopifyOrderId: string) => {
    setSelectedIds((current) =>
      current.includes(shopifyOrderId)
        ? current.filter((id) => id !== shopifyOrderId)
        : [...current, shopifyOrderId],
    );
  };

  const allOnPageSelected =
    orders.length > 0 &&
    orders.every((order) => selectedIds.includes(order.shopifyOrderId));
  const someOnPageSelected = orders.some((order) =>
    selectedIds.includes(order.shopifyOrderId),
  );

  const toggleSelectAllOnPage = () => {
    setSelectedIds(allOnPageSelected ? [] : orders.map((o) => o.shopifyOrderId));
  };

  const goToNextOrdersPage = () => {
    setSelectedIds([]);
    if (pageInfo.endCursor) navigate(`?after=${pageInfo.endCursor}`);
  };

  const goToPreviousOrdersPage = () => {
    setSelectedIds([]);
    if (pageInfo.startCursor) navigate(`?before=${pageInfo.startCursor}`);
  };

  return (
    <s-page heading="SevDesk sync">
      <s-section heading="Live sync">
        <s-stack direction="inline" gap="base">
          <s-switch
            label={optimisticSyncEnabled ? "Sync enabled" : "Sync disabled"}
            checked={optimisticSyncEnabled}
            disabled={isToggling}
            onChange={toggleSync}
          />
        </s-stack>
      </s-section>

      <s-section heading="Orders">
        <s-stack direction="inline" gap="base">
          <s-button
            variant="secondary"
            {...(isSyncingAll ? { loading: true } : {})}
            onClick={syncAllUnsyncedOrders}
          >
            Sync all unsynced orders
          </s-button>
        </s-stack>
        <s-table variant="auto">
          {someOnPageSelected && (
            <s-box slot="filters">
              <s-stack direction="inline" gap="base">
                <s-text>{selectedIds.length} selected</s-text>
                <s-button
                  variant="primary"
                  {...(isSyncingSelected ? { loading: true } : {})}
                  onClick={syncSelectedOrders}
                >
                  Sync selected
                </s-button>
              </s-stack>
            </s-box>
          )}
          <s-table-header-row>
            <s-table-header>
              <s-checkbox
                checked={allOnPageSelected}
                indeterminate={someOnPageSelected && !allOnPageSelected}
                onChange={toggleSelectAllOnPage}
              />
            </s-table-header>
            <s-table-header>
              <s-clickable onClick={() => toggleSort("shopifyOrderName")}>
                {columnHeader("shopifyOrderName")}
              </s-clickable>
            </s-table-header>
            <s-table-header>
              <s-clickable onClick={() => toggleSort("createdAt")}>
                {columnHeader("createdAt")}
              </s-clickable>
            </s-table-header>
            <s-table-header>
              <s-clickable onClick={() => toggleSort("financialStatus")}>
                {columnHeader("financialStatus")}
              </s-clickable>
            </s-table-header>
            <s-table-header>
              <s-clickable onClick={() => toggleSort("alreadyInSevDesk")}>
                {columnHeader("alreadyInSevDesk")}
              </s-clickable>
            </s-table-header>
            <s-table-header>
              <s-clickable onClick={() => toggleSort("syncStatus")}>
                {columnHeader("syncStatus")}
              </s-clickable>
            </s-table-header>
          </s-table-header-row>
          <s-table-body>
            {sortedOrders.map((order) => (
              <s-table-row key={order.shopifyOrderId}>
                <s-table-cell>
                  <s-checkbox
                    checked={selectedIds.includes(order.shopifyOrderId)}
                    onChange={() => toggleRowSelected(order.shopifyOrderId)}
                  />
                </s-table-cell>
                <s-table-cell>{order.shopifyOrderName}</s-table-cell>
                <s-table-cell>
                  {new Date(order.createdAt).toLocaleDateString()}
                </s-table-cell>
                <s-table-cell>{order.financialStatus ?? ""}</s-table-cell>
                <s-table-cell>
                  {order.alreadyInSevDesk ? (
                    <s-badge tone="success">In SevDesk</s-badge>
                  ) : (
                    <s-badge tone="warning">Not in SevDesk yet</s-badge>
                  )}
                </s-table-cell>
                <s-table-cell>
                  {order.syncStatus ? (
                    <s-badge
                      tone={
                        BADGE_TONE[order.syncStatus as keyof StatusCounts] ??
                        "neutral"
                      }
                    >
                      {order.syncStatus}
                    </s-badge>
                  ) : (
                    "not queued"
                  )}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        <s-stack direction="inline" gap="base">
          <s-button
            variant="tertiary"
            disabled={!pageInfo.hasPreviousPage}
            onClick={goToPreviousOrdersPage}
          >
            Previous
          </s-button>
          <s-button
            variant="tertiary"
            disabled={!pageInfo.hasNextPage}
            onClick={goToNextOrdersPage}
          >
            Next
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Status">
        <s-stack direction="inline" gap="base">
          {STATUSES.map((status) => (
            <s-badge key={status} tone={BADGE_TONE[status]}>
              {status}: {statusCounts[status]}
            </s-badge>
          ))}
        </s-stack>
        <s-paragraph>Counts reflect all sync items for this shop.</s-paragraph>
      </s-section>

      <s-section heading="Recent sync activity">
        <s-paragraph>Showing the most recent 50 items.</s-paragraph>
        <s-table variant="auto">
          <s-table-header-row>
            <s-table-header>Order</s-table-header>
            <s-table-header>Topic</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Attempts</s-table-header>
            <s-table-header>Last error</s-table-header>
            <s-table-header>Updated</s-table-header>
            <s-table-header>Action</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {items.map((item) => (
              <s-table-row key={item.id}>
                <s-table-cell>{item.shopifyOrderName}</s-table-cell>
                <s-table-cell>{item.topic}</s-table-cell>
                <s-table-cell>
                  <s-badge tone={BADGE_TONE[item.status as keyof StatusCounts] ?? "neutral"}>
                    {item.status}
                  </s-badge>
                </s-table-cell>
                <s-table-cell>{item.attempts}</s-table-cell>
                <s-table-cell>{item.lastError ?? ""}</s-table-cell>
                <s-table-cell>
                  {new Date(item.updatedAt).toLocaleString()}
                </s-table-cell>
                <s-table-cell>
                  {item.status === "error" && (
                    <s-button
                      variant="tertiary"
                      {...(retryFetcher.state !== "idle" &&
                      retryFetcher.formData?.get("itemId") === item.id
                        ? { loading: true }
                        : {})}
                      onClick={() => retryItem(item.id)}
                    >
                      Retry
                    </s-button>
                  )}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
