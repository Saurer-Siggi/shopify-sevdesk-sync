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
  categoryId: string;
}

export interface OrderLineItem {
  name: string;
  quantity: number;
  unitPriceGross: number;
  taxRatePercent: number;
}

export interface OrderAddress {
  name: string;
  street: string;
  zip: string;
  city: string;
}

export interface CreateInvoiceInput {
  orderName: string;
  contactId: string;
  invoiceDate: Date;
  deliverDate: Date;
  lineItems: OrderLineItem[];
  address: OrderAddress;
  contactPersonId: string;
  taxRuleId: string;
  currency: string;
  status: string;
}

export interface CreateCreditNoteInput {
  orderName: string;
  contactId: string;
  relatedInvoiceId: string;
  creditNoteDate: Date;
  lineItems: OrderLineItem[];
  address: OrderAddress;
  contactPersonId: string;
  taxRuleId: string;
  currency: string;
  status: string;
}
