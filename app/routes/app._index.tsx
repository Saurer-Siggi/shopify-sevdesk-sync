import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { triggerBackfill } from "../sync/backfill.server";

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

  return {
    syncEnabled: settings.syncEnabled,
    items,
    statusCounts,
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

  if (intent === "backfill") {
    const dateFrom = String(formData.get("dateFrom") ?? "");
    const dateTo = String(formData.get("dateTo") ?? "");
    const { enqueued, truncated } = await triggerBackfill(shop, dateFrom, dateTo);
    return { intent, enqueued, truncated };
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

export default function Index() {
  const { syncEnabled, items, statusCounts } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();

  const toggleFetcher = useFetcher<typeof action>();
  const backfillFetcher = useFetcher<typeof action>();
  const retryFetcher = useFetcher<typeof action>();

  const isToggling = toggleFetcher.state !== "idle";
  const isBackfilling = backfillFetcher.state !== "idle";

  const optimisticSyncEnabled =
    toggleFetcher.formData?.get("intent") === "toggle"
      ? !syncEnabled
      : syncEnabled;

  useEffect(() => {
    if (backfillFetcher.data?.intent === "backfill") {
      const { enqueued, truncated } = backfillFetcher.data;
      shopify.toast.show(
        truncated
          ? `Backfill queued ${enqueued} order(s) but hit the page limit — date range may be incomplete, narrow it and re-run`
          : `Backfill queued: ${enqueued} order(s) enqueued`,
        truncated ? { isError: true } : undefined,
      );
    }
  }, [backfillFetcher.data, shopify]);

  useEffect(() => {
    if (retryFetcher.data?.intent === "retry") {
      shopify.toast.show(
        retryFetcher.data.retried ? "Retry queued" : "Retry failed",
      );
    }
  }, [retryFetcher.data, shopify]);

  const toggleSync = () => {
    toggleFetcher.submit({ intent: "toggle" }, { method: "POST" });
  };

  const submitBackfill = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set("intent", "backfill");
    backfillFetcher.submit(form, { method: "POST" });
  };

  const retryItem = (itemId: string) => {
    retryFetcher.submit({ intent: "retry", itemId }, { method: "POST" });
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

      <s-section heading="Historical backfill">
        <form onSubmit={submitBackfill}>
          <s-stack direction="inline" gap="base">
            <input type="date" name="dateFrom" required />
            <input type="date" name="dateTo" required />
            <s-button
              type="submit"
              {...(isBackfilling ? { loading: true } : {})}
            >
              Trigger backfill
            </s-button>
          </s-stack>
        </form>
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
