import type { SyncItem } from "@prisma/client";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  createCreditNoteForOrder,
  createInvoiceForOrder,
  findInvoicesByOrderName,
  upsertContactByEmail,
} from "../sevdesk/client.server";
import type { ContactInput, OrderLineItem } from "../sevdesk/types";

const ORDER_FOR_SYNC_QUERY = `#graphql
  query OrderForSync($id: ID!) {
    order(id: $id) {
      id
      name
      email
      customer {
        id
        firstName
        lastName
        displayName
        defaultEmailAddress {
          emailAddress
        }
      }
      lineItems(first: 250) {
        nodes {
          title
          quantity
          originalUnitPriceSet {
            shopMoney {
              amount
            }
          }
          taxLines {
            ratePercentage
          }
        }
      }
    }
  }
`;

interface OrderForSyncResponse {
  data: {
    order: {
      id: string;
      name: string;
      email: string | null;
      customer: {
        id: string;
        firstName: string | null;
        lastName: string | null;
        displayName: string;
        defaultEmailAddress: { emailAddress: string } | null;
      } | null;
      lineItems: {
        nodes: Array<{
          title: string;
          quantity: number;
          originalUnitPriceSet: { shopMoney: { amount: string } };
          taxLines: Array<{ ratePercentage: number | null }>;
        }>;
      };
    } | null;
  };
}

const INVOICE_TOPICS = new Set(["orders/create", "orders/paid", "backfill"]);
const CREDIT_NOTE_TOPICS = new Set(["orders/cancelled", "refunds/create"]);

function toOrderGid(shopifyOrderId: string): string {
  return shopifyOrderId.startsWith("gid://")
    ? shopifyOrderId
    : `gid://shopify/Order/${shopifyOrderId}`;
}

function resolveEmail(order: OrderForSyncResponse["data"]["order"]): string {
  const email =
    order?.customer?.defaultEmailAddress?.emailAddress ?? order?.email;
  if (!email) {
    throw new Error(`Order ${order?.name ?? "unknown"} has no usable email`);
  }
  return email;
}

function buildContactInput(
  order: NonNullable<OrderForSyncResponse["data"]["order"]>,
): ContactInput {
  return {
    email: resolveEmail(order),
    firstName: order.customer?.firstName ?? undefined,
    lastName: order.customer?.lastName ?? undefined,
  };
}

function buildLineItems(
  order: NonNullable<OrderForSyncResponse["data"]["order"]>,
): OrderLineItem[] {
  return order.lineItems.nodes.map((node) => ({
    name: node.title,
    quantity: node.quantity,
    unitPriceGross: Number(node.originalUnitPriceSet.shopMoney.amount),
    taxRatePercent: node.taxLines[0]?.ratePercentage ?? 0,
  }));
}

export async function processSyncItem(item: SyncItem): Promise<void> {
  let realOrderName: string | undefined;
  try {
    const { admin } = await unauthenticated.admin(item.shop);
    const response = await admin.graphql(ORDER_FOR_SYNC_QUERY, {
      variables: { id: toOrderGid(item.shopifyOrderId) },
    });
    const { data } = (await response.json()) as OrderForSyncResponse;

    if (!data.order) {
      throw new Error(`Order ${item.shopifyOrderId} not found in Shopify`);
    }
    const order = data.order;
    realOrderName = order.name;

    console.log(
      `Processing ${item.topic} for order ${realOrderName} (${item.shopifyOrderId})`,
    );

    const matches = await findInvoicesByOrderName(realOrderName);

    if (INVOICE_TOPICS.has(item.topic)) {
      await handleInvoiceTopic(item, order, realOrderName, matches);
      return;
    }

    if (CREDIT_NOTE_TOPICS.has(item.topic)) {
      await handleCreditNoteTopic(item, order, realOrderName, matches);
      return;
    }

    throw new Error(`Unknown sync topic: ${item.topic}`);
  } catch (error) {
    await db.syncItem.update({
      where: { id: item.id },
      data: {
        attempts: { increment: 1 },
        status: "error",
        lastError: String(
          error instanceof Error ? error.message : error,
        ).slice(0, 500),
        // Persist the resolved order name even on failure so the admin UI
        // never shows a raw Shopify id for a refund row stuck in "error".
        ...(realOrderName ? { shopifyOrderName: realOrderName } : {}),
      },
    });
  }
}

async function handleInvoiceTopic(
  item: SyncItem,
  order: NonNullable<OrderForSyncResponse["data"]["order"]>,
  realOrderName: string,
  matches: Awaited<ReturnType<typeof findInvoicesByOrderName>>,
): Promise<void> {
  if (matches.length > 0) {
    console.log(`Order ${realOrderName} already invoiced, skipping`);
    await db.syncItem.update({
      where: { id: item.id },
      data: {
        status: "duplicate_skipped",
        sevdeskInvoiceId: matches[0].id,
        shopifyOrderName: realOrderName,
      },
    });
    return;
  }

  const contact = await upsertContactByEmail(buildContactInput(order));
  const invoice = await createInvoiceForOrder({
    orderName: realOrderName,
    contactId: contact.id,
    invoiceDate: new Date(),
    lineItems: buildLineItems(order),
  });

  console.log(`Created invoice for order ${realOrderName}`);
  await db.syncItem.update({
    where: { id: item.id },
    data: {
      status: "success",
      sevdeskInvoiceId: invoice.id,
      shopifyOrderName: realOrderName,
    },
  });
}

async function handleCreditNoteTopic(
  item: SyncItem,
  order: NonNullable<OrderForSyncResponse["data"]["order"]>,
  realOrderName: string,
  matches: Awaited<ReturnType<typeof findInvoicesByOrderName>>,
): Promise<void> {
  if (matches.length === 0) {
    console.log(`No invoice found for order ${realOrderName}, skipping credit note`);
    await db.syncItem.update({
      where: { id: item.id },
      data: {
        status: "skipped_no_invoice",
        shopifyOrderName: realOrderName,
      },
    });
    return;
  }

  if (matches.length > 1) {
    // Confirmed to happen in the live account (FINDINGS.md) — no principled way to
    // pick the "right" one automatically, so use the first and flag it for a human.
    console.log(
      `Order ${realOrderName} has ${matches.length} matching invoices; crediting the first`,
    );
  }

  const contact = await upsertContactByEmail(buildContactInput(order));
  const creditNote = await createCreditNoteForOrder({
    orderName: realOrderName,
    contactId: contact.id,
    relatedInvoiceId: matches[0].id,
    creditNoteDate: new Date(),
    lineItems: buildLineItems(order),
  });

  console.log(`Created credit note for order ${realOrderName}`);
  await db.syncItem.update({
    where: { id: item.id },
    data: {
      status: "success",
      sevdeskInvoiceId: creditNote.id,
      shopifyOrderName: realOrderName,
    },
  });
}
