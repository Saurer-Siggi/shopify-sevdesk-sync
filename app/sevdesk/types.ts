export interface SevDeskInvoiceRef {
  id: string;
  invoiceNumber: string;
}

export interface SevDeskContactRef {
  id: string;
}

export interface SevDeskCreditNoteRef {
  id: string;
}

export interface ContactInput {
  email: string;
  firstName?: string;
  lastName?: string;
  company?: string;
}

export interface OrderLineItem {
  name: string;
  quantity: number;
  unitPriceGross: number;
  taxRatePercent: number;
}

export interface CreateInvoiceInput {
  orderName: string;
  contactId: string;
  invoiceDate: Date;
  lineItems: OrderLineItem[];
}

export interface CreateCreditNoteInput {
  orderName: string;
  contactId: string;
  relatedInvoiceId: string;
  creditNoteDate: Date;
  lineItems: OrderLineItem[];
}
