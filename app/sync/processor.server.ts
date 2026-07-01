import type { SyncItem } from "@prisma/client";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  createCreditNoteForOrder,
  createInvoiceForOrder,
  findInvoicesByOrderName,
  tagObject,
  upsertContactByEmail,
} from "../sevdesk/client.server";
import type { ContactInput, OrderAddress, OrderLineItem } from "../sevdesk/types";

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
      shippingAddress {
        name
        address1
        zip
        city
      }
      billingAddress {
        name
        address1
        zip
        city
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

interface RawShopifyAddress {
  name: string | null;
  address1: string | null;
  zip: string | null;
  city: string | null;
}

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
      shippingAddress: RawShopifyAddress | null;
      billingAddress: RawShopifyAddress | null;
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

interface ResolvedSevDeskSettings {
  sevdeskContactPersonId: string;
  sevdeskTaxRuleId: string;
  sevdeskCategoryId: string;
  invoiceStatus: string;
  currency: string;
}

function resolveSettings(
  settings: {
    sevdeskContactPersonId: string | null;
    sevdeskTaxRuleId: string | null;
    sevdeskCategoryId: string | null;
    invoiceStatus: string | null;
    currency: string | null;
  } | null,
): ResolvedSevDeskSettings {
  if (
    !settings ||
    !settings.sevdeskContactPersonId ||
    !settings.sevdeskTaxRuleId ||
    !settings.sevdeskCategoryId ||
    !settings.invoiceStatus ||
    !settings.currency
  ) {
    throw new Error("SevDesk settings not configured — visit the Settings page");
  }
  return {
    sevdeskContactPersonId: settings.sevdeskContactPersonId,
    sevdeskTaxRuleId: settings.sevdeskTaxRuleId,
    sevdeskCategoryId: settings.sevdeskCategoryId,
    invoiceStatus: settings.invoiceStatus,
    currency: settings.currency,
  };
}

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

function resolveAddress(
  order: NonNullable<OrderForSyncResponse["data"]["order"]>,
): OrderAddress {
  const raw = order.shippingAddress ?? order.billingAddress;
  if (!raw?.address1 || !raw.zip || !raw.city) {
    throw new Error(`Order ${order.name} has no usable address`);
  }
  return {
    name: raw.name ?? order.customer?.displayName ?? "",
    street: raw.address1,
    zip: raw.zip,
    city: raw.city,
  };
}

function buildContactInput(
  order: NonNullable<OrderForSyncResponse["data"]["order"]>,
  categoryId: string,
): ContactInput {
  return {
    email: resolveEmail(order),
    firstName: order.customer?.firstName ?? undefined,
    lastName: order.customer?.lastName ?? undefined,
    categoryId,
  };
}

function shopHandle(shop: string): string {
  return shop.replace(/\.myshopify\.com$/, "");
}

// Mirrors the old official app's tags (confirmed in FINDINGS.md: every one of
// its invoices carries "Shopify" + the shop handle + an order-number tag) so
// invoices stay filterable in the SevDesk UI the same way they always have.
// Never fatal — a tagging hiccup shouldn't undo an otherwise-successful sync.
async function applyShopifyTags(
  shop: string,
  orderName: string,
  sevdeskId: string,
  objectType: "Invoice" | "CreditNote",
): Promise<void> {
  try {
    await tagObject(sevdeskId, objectType, [
      "Shopify",
      shopHandle(shop),
      orderName,
    ]);
  } catch (error) {
    console.error(
      `Failed to tag ${objectType} for order ${orderName}: ${String(error)}`,
    );
  }
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

    const settings = resolveSettings(
      await db.syncSettings.findUnique({ where: { shop: item.shop } }),
    );

    const matches = await findInvoicesByOrderName(realOrderName);

    if (INVOICE_TOPICS.has(item.topic)) {
      await handleInvoiceTopic(item, order, realOrderName, matches, settings);
      return;
    }

    if (CREDIT_NOTE_TOPICS.has(item.topic)) {
      await handleCreditNoteTopic(item, order, realOrderName, matches, settings);
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
  settings: ResolvedSevDeskSettings,
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

  const contact = await upsertContactByEmail(
    buildContactInput(order, settings.sevdeskCategoryId),
  );
  const invoice = await createInvoiceForOrder({
    orderName: realOrderName,
    contactId: contact.id,
    invoiceDate: new Date(),
    lineItems: buildLineItems(order),
    address: resolveAddress(order),
    contactPersonId: settings.sevdeskContactPersonId,
    taxRuleId: settings.sevdeskTaxRuleId,
    currency: settings.currency,
    status: settings.invoiceStatus,
  });

  console.log(`Created invoice for order ${realOrderName}`);
  await applyShopifyTags(item.shop, realOrderName, invoice.id, "Invoice");
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
  settings: ResolvedSevDeskSettings,
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

  const contact = await upsertContactByEmail(
    buildContactInput(order, settings.sevdeskCategoryId),
  );
  const creditNote = await createCreditNoteForOrder({
    orderName: realOrderName,
    contactId: contact.id,
    relatedInvoiceId: matches[0].id,
    creditNoteDate: new Date(),
    lineItems: buildLineItems(order),
    address: resolveAddress(order),
    contactPersonId: settings.sevdeskContactPersonId,
    taxRuleId: settings.sevdeskTaxRuleId,
    currency: settings.currency,
    status: settings.invoiceStatus,
  });

  console.log(`Created credit note for order ${realOrderName}`);
  await applyShopifyTags(
    item.shop,
    realOrderName,
    creditNote.id,
    "CreditNote",
  );
  await db.syncItem.update({
    where: { id: item.id },
    data: {
      status: "success",
      sevdeskInvoiceId: creditNote.id,
      shopifyOrderName: realOrderName,
    },
  });
}
