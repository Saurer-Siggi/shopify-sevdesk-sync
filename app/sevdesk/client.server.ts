import { sevGet, sevPost } from "./http.server";
import type {
  ContactInput,
  CreateCreditNoteInput,
  CreateInvoiceInput,
  OrderLineItem,
  SevDeskContactRef,
  SevDeskCreditNoteRef,
  SevDeskInvoiceRef,
} from "./types";

const EMAIL_COMMUNICATION_TYPE = "EMAIL";

interface RawInvoice {
  id: string;
  invoiceNumber: string;
  customerInternalNote?: string | null;
}

export async function findInvoicesByOrderName(
  orderName: string,
): Promise<SevDeskInvoiceRef[]> {
  const invoices = await sevGet<RawInvoice>("/Invoice", {
    customerInternalNote: orderName,
  });
  return invoices
    .filter((inv) => inv.customerInternalNote === orderName)
    .map((inv) => ({ id: inv.id, invoiceNumber: inv.invoiceNumber }));
}

interface RawCommunicationWay {
  id: string;
  value: string;
  contact: { id: string; objectName: "Contact" };
}

interface RawContact {
  id: string;
}

export async function upsertContactByEmail(
  input: ContactInput,
): Promise<SevDeskContactRef> {
  const existing = await findContactIdByEmail(input.email);
  if (existing) return { id: existing };

  const created = await sevPost<{ objects: RawContact }>(
    "/Contact",
    buildContactPayload(input),
  );
  const contactId = created.objects.id;

  await sevPost("/CommunicationWay", {
    type: EMAIL_COMMUNICATION_TYPE,
    value: input.email,
    key: { id: "1", objectName: "CommunicationWayKey" },
    contact: { id: contactId, objectName: "Contact" },
    main: true,
    objectName: "CommunicationWay",
    mapAll: true,
  });

  return { id: contactId };
}

async function findContactIdByEmail(email: string): Promise<string | null> {
  const ways = await sevGet<RawCommunicationWay>("/CommunicationWay", {
    type: EMAIL_COMMUNICATION_TYPE,
    value: email,
  });
  const match = ways.find((way) => way.value === email);
  return match ? match.contact.id : null;
}

function buildContactPayload(input: ContactInput) {
  const person = !input.company;
  return {
    ...(person
      ? { surename: input.firstName, familyname: input.lastName }
      : { name: input.company }),
    category: { id: input.categoryId, objectName: "Category" },
    objectName: "Contact",
    mapAll: true,
  };
}

interface RawInvoiceFactoryResponse {
  objects: { invoice: RawInvoice };
}

export async function createInvoiceForOrder(
  input: CreateInvoiceInput,
): Promise<SevDeskInvoiceRef> {
  const result = await sevPost<RawInvoiceFactoryResponse>(
    "/Invoice/Factory/saveInvoice",
    {
      invoice: {
        contact: { id: input.contactId, objectName: "Contact" },
        contactPerson: { id: input.contactPersonId, objectName: "SevUser" },
        invoiceDate: formatDate(input.invoiceDate),
        status: input.status,
        invoiceType: "RE",
        currency: input.currency,
        taxRule: { id: input.taxRuleId, objectName: "TaxRule" },
        // SevDesk requires a header-level taxRate even though positions carry
        // their own; use the first line item's rate as the representative one.
        taxRate: input.lineItems[0]?.taxRatePercent ?? 19,
        customerInternalNote: input.orderName,
        objectName: "Invoice",
        mapAll: true,
      },
      invoicePosSave: input.lineItems.map((item) => buildInvoicePos(item)),
      invoicePosDelete: null,
      discountSave: null,
      discountDelete: null,
      takeDefaultAddress: true,
    },
  );
  return {
    id: result.objects.invoice.id,
    invoiceNumber: result.objects.invoice.invoiceNumber,
  };
}

function buildInvoicePos(item: OrderLineItem) {
  return {
    quantity: item.quantity,
    price: item.unitPriceGross,
    name: item.name,
    taxRate: item.taxRatePercent,
    unity: { id: "1", objectName: "Unity" },
    objectName: "InvoicePos",
    mapAll: true,
  };
}

interface RawCreditNote {
  id: string;
}

interface RawCreditNoteFactoryResponse {
  objects: { creditNote: RawCreditNote };
}

export async function createCreditNoteForOrder(
  input: CreateCreditNoteInput,
): Promise<SevDeskCreditNoteRef> {
  const result = await sevPost<RawCreditNoteFactoryResponse>(
    "/CreditNote/Factory/saveCreditNote",
    {
      creditNote: {
        contact: { id: input.contactId, objectName: "Contact" },
        contactPerson: { id: input.contactPersonId, objectName: "SevUser" },
        creditNoteDate: formatDate(input.creditNoteDate),
        status: input.status,
        currency: input.currency,
        taxRule: { id: input.taxRuleId, objectName: "TaxRule" },
        taxRate: input.lineItems[0]?.taxRatePercent ?? 19,
        customerInternalNote: input.orderName,
        refSrcInvoice: { id: input.relatedInvoiceId, objectName: "Invoice" },
        bookingCategory: "UNDERACHIEVEMENT",
        objectName: "CreditNote",
        mapAll: true,
      },
      creditNotePosSave: input.lineItems.map((item) => ({
        quantity: item.quantity,
        price: item.unitPriceGross,
        name: item.name,
        taxRate: item.taxRatePercent,
        unity: { id: "1", objectName: "Unity" },
        objectName: "CreditNotePos",
        mapAll: true,
      })),
      creditNotePosDelete: null,
      discountSave: null,
      discountDelete: null,
      takeDefaultAddress: true,
      forCashRegister: false,
    },
  );
  return { id: result.objects.creditNote.id };
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface RawTag {
  id: string;
}

// The tag names "Shopify" and the shop handle never change within a process,
// so caching their ids avoids re-querying SevDesk on every single invoice.
const tagIdCache = new Map<string, string>();

async function findOrCreateTagId(name: string): Promise<string> {
  const cached = tagIdCache.get(name);
  if (cached) return cached;

  const existing = await sevGet<RawTag>("/Tag", { name });
  if (existing[0]) {
    tagIdCache.set(name, existing[0].id);
    return existing[0].id;
  }

  const created = await sevPost<{ objects: RawTag }>("/Tag", {
    name,
    objectName: "Tag",
  });
  tagIdCache.set(name, created.objects.id);
  return created.objects.id;
}

// Mirrors the old official app's tagging so invoices/credit notes stay
// filterable/searchable in the SevDesk UI the same way they always have been.
export async function tagObject(
  objectId: string,
  objectType: "Invoice" | "CreditNote",
  tagNames: string[],
): Promise<void> {
  for (const name of tagNames) {
    const tagId = await findOrCreateTagId(name);
    await sevPost("/TagRelation", {
      tag: { id: tagId, objectName: "Tag" },
      object: { id: objectId, objectName: objectType },
      objectName: "TagRelation",
      mapAll: true,
    });
  }
}

interface RawSevUser {
  id: string;
  fullname: string;
}

export async function listSevUsers(): Promise<
  { id: string; fullname: string }[]
> {
  const users = await sevGet<RawSevUser>("/SevUser");
  return users.map((user) => ({ id: user.id, fullname: user.fullname }));
}

interface RawTaxRule {
  id: string;
  name: string;
}

export async function listTaxRules(): Promise<{ id: string; name: string }[]> {
  const rules = await sevGet<RawTaxRule>("/TaxRule");
  return rules.map((rule) => ({ id: rule.id, name: rule.name }));
}
