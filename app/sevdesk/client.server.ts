import { contactPersonId, sevGet, sevPost } from "./http.server";
import type {
  ContactInput,
  CreateCreditNoteInput,
  CreateInvoiceInput,
  OrderLineItem,
  SevDeskContactRef,
  SevDeskCreditNoteRef,
  SevDeskInvoiceRef,
} from "./types";

const CUSTOMER_CATEGORY_ID = "3";
const STANDARD_TAX_RULE_ID = "1";
const EMAIL_COMMUNICATION_TYPE = "EMAIL";
const CURRENCY = "EUR";
const INVOICE_STATUS_DRAFT = "100";

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
    category: { id: CUSTOMER_CATEGORY_ID, objectName: "Category" },
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
        contactPerson: { id: contactPersonId(), objectName: "SevUser" },
        invoiceDate: formatDate(input.invoiceDate),
        status: INVOICE_STATUS_DRAFT,
        invoiceType: "RE",
        currency: CURRENCY,
        taxRule: { id: STANDARD_TAX_RULE_ID, objectName: "TaxRule" },
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
        contactPerson: { id: contactPersonId(), objectName: "SevUser" },
        creditNoteDate: formatDate(input.creditNoteDate),
        status: INVOICE_STATUS_DRAFT,
        currency: CURRENCY,
        taxRule: { id: STANDARD_TAX_RULE_ID, objectName: "TaxRule" },
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
