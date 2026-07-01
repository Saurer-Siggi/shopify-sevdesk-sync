import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bookInvoicePayment,
  createCreditNoteForOrder,
  createInvoiceForOrder,
  findInvoicesByOrderName,
  listCheckAccounts,
  listSevUsers,
  listTaxRules,
  tagObject,
  upsertContactByEmail,
} from "./client.server";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.SEVDESK_API_TOKEN = "test-token";
});

describe("findInvoicesByOrderName", () => {
  it("returns the matching invoice", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        objects: [
          {
            id: "1",
            invoiceNumber: "RN-2026-1223",
            customerInternalNote: "#1034",
          },
        ],
      }),
    );

    const result = await findInvoicesByOrderName("#1034");

    expect(result).toEqual([{ id: "1", invoiceNumber: "RN-2026-1223" }]);
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toContain("/Invoice");
    expect(url.searchParams.get("customerInternalNote")).toBe("#1034");
  });

  it("returns every match when the same note appears on multiple invoices", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        objects: [
          { id: "1", invoiceNumber: "RN-2025-1088", customerInternalNote: "#1004" },
          { id: "2", invoiceNumber: "RN-2025-1089", customerInternalNote: "#1004" },
        ],
      }),
    );

    const result = await findInvoicesByOrderName("#1004");

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("returns an empty array when nothing matches", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ objects: [] }));

    const result = await findInvoicesByOrderName("#9999");

    expect(result).toEqual([]);
  });

  it("filters out near-matches the server-side query might over-return", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        objects: [
          { id: "1", invoiceNumber: "RN-2026-0001", customerInternalNote: "#1034" },
          { id: "2", invoiceNumber: "RN-2026-0002", customerInternalNote: "#10345" },
        ],
      }),
    );

    const result = await findInvoicesByOrderName("#1034");

    expect(result).toEqual([{ id: "1", invoiceNumber: "RN-2026-0001" }]);
  });
});

describe("upsertContactByEmail", () => {
  it("returns the existing contact id when a communication way already matches", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        objects: [
          {
            id: "99",
            value: "test@example.invalid",
            contact: { id: "501", objectName: "Contact" },
          },
        ],
      }),
    );

    const result = await upsertContactByEmail({
      email: "test@example.invalid",
      firstName: "Max",
      lastName: "Mustermann",
      categoryId: "3",
    });

    expect(result).toEqual({ id: "501" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("creates a contact and its email communication way when no match exists", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ objects: [] }))
      .mockResolvedValueOnce(jsonResponse({ objects: { id: "777" } }))
      .mockResolvedValueOnce(jsonResponse({ objects: { id: "1" } }));

    const result = await upsertContactByEmail({
      email: "test@example.invalid",
      firstName: "Max",
      lastName: "Mustermann",
      categoryId: "3",
    });

    expect(result).toEqual({ id: "777" });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [createContactUrl, createContactInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(createContactUrl).toContain("/Contact");
    const contactBody = JSON.parse(createContactInit.body as string);
    expect(contactBody).toMatchObject({
      surename: "Max",
      familyname: "Mustermann",
      category: { id: "3", objectName: "Category" },
    });

    const [addEmailUrl, addEmailInit] = fetchMock.mock.calls[2] as [
      string,
      RequestInit,
    ];
    expect(addEmailUrl).toContain("/CommunicationWay");
    const emailBody = JSON.parse(addEmailInit.body as string);
    expect(emailBody).toMatchObject({
      type: "EMAIL",
      value: "test@example.invalid",
      contact: { id: "777", objectName: "Contact" },
    });
  });

  it("creates a company contact by name when a company is given instead of a person", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ objects: [] }))
      .mockResolvedValueOnce(jsonResponse({ objects: { id: "888" } }))
      .mockResolvedValueOnce(jsonResponse({ objects: { id: "1" } }));

    await upsertContactByEmail({
      email: "orders@example.invalid",
      company: "Beispiel GmbH",
      categoryId: "3",
    });

    const [, createContactInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ];
    const contactBody = JSON.parse(createContactInit.body as string);
    expect(contactBody).toMatchObject({ name: "Beispiel GmbH" });
    expect(contactBody.surename).toBeUndefined();
  });
});

describe("createInvoiceForOrder", () => {
  it("maps line items and always sets customerInternalNote to the order name", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        objects: { invoice: { id: "1001", invoiceNumber: "RN-2026-2000" } },
      }),
    );

    const result = await createInvoiceForOrder({
      orderName: "#1050",
      contactId: "501",
      invoiceDate: new Date("2026-07-01T00:00:00.000Z"),
      deliverDate: new Date("2026-06-30T00:00:00.000Z"),
      lineItems: [
        { name: "Kräuterlikör 0,7l", quantity: 2, unitPriceGross: 19.99, taxRatePercent: 19 },
        { name: "Bio-Apfelsaft 1l", quantity: 1, unitPriceGross: 3.49, taxRatePercent: 7 },
      ],
      address: { name: "Test Kundin", street: "Teststraße 1", zip: "12345", city: "Teststadt" },
      contactPersonId: "999",
      taxRuleId: "1",
      currency: "EUR",
    });

    expect(result).toEqual({ id: "1001", invoiceNumber: "RN-2026-2000" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/Invoice/Factory/saveInvoice");
    const body = JSON.parse(init.body as string);

    expect(body.invoice.customerInternalNote).toBe("#1050");
    expect(body.invoice.invoiceDate).toBe("2026-07-01");
    expect(body.invoice.deliveryDate).toBe("2026-06-30");
    expect(body.invoice.taxRule).toEqual({ id: "1", objectName: "TaxRule" });
    // SevDesk rejects invoice creation with a DB-level error if this header field is missing.
    expect(body.invoice.taxRate).toBe(19);
    expect(body.invoice.addressName).toBe("Test Kundin");
    expect(body.invoice.addressStreet).toBe("Teststraße 1");
    expect(body.invoice.addressZip).toBe("12345");
    expect(body.invoice.addressCity).toBe("Teststadt");
    expect(body.invoice.addressCountry).toEqual({ id: "1", objectName: "StaticCountry" });
    expect(body.takeDefaultAddress).toBe(false);
    expect(body.invoice.header).toBe("Rechnung zur Bestellung #1050");
    expect(body.invoice.headText).toContain("vielen Dank für Ihre Bestellung");
    expect(body.invoice.footText).toContain("[%PAYPAL%]");
    expect(body.invoice.contact).toEqual({ id: "501", objectName: "Contact" });
    expect(body.invoice.contactPerson).toEqual({ id: "999", objectName: "SevUser" });
    expect(body.invoice.currency).toBe("EUR");
    expect(body.invoice.status).toBe("100");
    expect(body.invoicePosSave).toHaveLength(2);
    expect(body.invoicePosSave[0]).toMatchObject({
      name: "Kräuterlikör 0,7l",
      quantity: 2,
      price: 19.99,
      taxRate: 19,
    });
    expect(body.invoicePosSave[1]).toMatchObject({
      name: "Bio-Apfelsaft 1l",
      quantity: 1,
      price: 3.49,
      taxRate: 7,
    });
  });

  it("still sets customerInternalNote with a single line item", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        objects: { invoice: { id: "1002", invoiceNumber: "RN-2026-2001" } },
      }),
    );

    await createInvoiceForOrder({
      orderName: "#1051",
      contactId: "502",
      invoiceDate: new Date("2026-07-01T00:00:00.000Z"),
      deliverDate: new Date("2026-06-30T00:00:00.000Z"),
      lineItems: [
        { name: "Kräuterlikör 0,7l", quantity: 1, unitPriceGross: 19.99, taxRatePercent: 19 },
      ],
      address: { name: "Test Kundin", street: "Teststraße 1", zip: "12345", city: "Teststadt" },
      contactPersonId: "999",
      taxRuleId: "1",
      currency: "EUR",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.invoice.customerInternalNote).toBe("#1051");
  });
});

describe("createCreditNoteForOrder", () => {
  it("maps line items and references the original invoice", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ objects: { creditNote: { id: "2001" } } }),
    );

    const result = await createCreditNoteForOrder({
      orderName: "#1050",
      contactId: "501",
      relatedInvoiceId: "1001",
      creditNoteDate: new Date("2026-07-05T00:00:00.000Z"),
      lineItems: [
        { name: "Kräuterlikör 0,7l", quantity: 1, unitPriceGross: 19.99, taxRatePercent: 19 },
      ],
      address: { name: "Test Kundin", street: "Teststraße 1", zip: "12345", city: "Teststadt" },
      contactPersonId: "999",
      taxRuleId: "1",
      currency: "EUR",
    });

    expect(result).toEqual({ id: "2001" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/CreditNote/Factory/saveCreditNote");
    const body = JSON.parse(init.body as string);

    expect(body.creditNote.customerInternalNote).toBe("#1050");
    expect(body.creditNote.taxRate).toBe(19);
    expect(body.creditNote.addressName).toBe("Test Kundin");
    expect(body.takeDefaultAddress).toBe(false);
    expect(body.creditNote.refSrcInvoice).toEqual({
      id: "1001",
      objectName: "Invoice",
    });
    expect(body.creditNote.contactPerson).toEqual({ id: "999", objectName: "SevUser" });
    expect(body.creditNote.currency).toBe("EUR");
    expect(body.creditNote.status).toBe("100");
    expect(body.creditNotePosSave).toHaveLength(1);
    expect(body.creditNotePosSave[0]).toMatchObject({
      name: "Kräuterlikör 0,7l",
      quantity: 1,
      price: 19.99,
      taxRate: 19,
    });
  });
});

describe("listSevUsers", () => {
  it("maps raw SevUser objects to id/fullname", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        objects: [{ id: "999", fullname: "Test User" }],
      }),
    );

    const result = await listSevUsers();

    expect(result).toEqual([{ id: "999", fullname: "Test User" }]);
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toContain("/SevUser");
  });
});

describe("listTaxRules", () => {
  it("maps raw TaxRule objects to id/name", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        objects: [{ id: "1", name: "Standard 19%" }],
      }),
    );

    const result = await listTaxRules();

    expect(result).toEqual([{ id: "1", name: "Standard 19%" }]);
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toContain("/TaxRule");
  });
});

describe("listCheckAccounts", () => {
  it("maps raw CheckAccount objects to id/name", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        objects: [{ id: "42", name: "Bank Girokonto" }],
      }),
    );

    const result = await listCheckAccounts();

    expect(result).toEqual([{ id: "42", name: "Bank Girokonto" }]);
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toContain("/CheckAccount");
  });
});

describe("bookInvoicePayment", () => {
  it("PUTs the expected bookAmount payload", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ objects: {} }));

    await bookInvoicePayment({
      invoiceId: "1001",
      amount: 23.48,
      date: "2026-06-30",
      checkAccountId: "42",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/Invoice/1001/bookAmount");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      amount: 23.48,
      date: "2026-06-30",
      type: "N",
      checkAccount: { id: "42", objectName: "CheckAccount" },
      createFeed: true,
    });
  });
});

describe("tagObject", () => {
  it("creates a new tag and links it when no matching tag exists", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ objects: [] }))
      .mockResolvedValueOnce(jsonResponse({ objects: { id: "9001" } }))
      .mockResolvedValueOnce(jsonResponse({ objects: { id: "1" } }));

    await tagObject("501", "Invoice", ["TestTagAlpha"]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [lookupUrl] = fetchMock.mock.calls[0] as [URL];
    expect(lookupUrl.toString()).toContain("/Tag");
    expect(lookupUrl.searchParams.get("name")).toBe("TestTagAlpha");

    const [createTagUrl, createTagInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(createTagUrl).toContain("/Tag");
    expect(JSON.parse(createTagInit.body as string)).toMatchObject({
      name: "TestTagAlpha",
    });

    const [relationUrl, relationInit] = fetchMock.mock.calls[2] as [
      string,
      RequestInit,
    ];
    expect(relationUrl).toContain("/TagRelation");
    expect(JSON.parse(relationInit.body as string)).toMatchObject({
      tag: { id: "9001", objectName: "Tag" },
      object: { id: "501", objectName: "Invoice" },
    });
  });

  it("reuses an existing tag by name instead of creating a duplicate", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ objects: [{ id: "8001", name: "TestTagBeta" }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ objects: { id: "1" } }));

    await tagObject("502", "CreditNote", ["TestTagBeta"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [relationUrl, relationInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(relationUrl).toContain("/TagRelation");
    expect(JSON.parse(relationInit.body as string)).toMatchObject({
      tag: { id: "8001", objectName: "Tag" },
      object: { id: "502", objectName: "CreditNote" },
    });
  });

  it("caches a resolved tag id across calls instead of re-querying", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ objects: [{ id: "8002", name: "TestTagGamma" }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ objects: { id: "1" } }))
      .mockResolvedValueOnce(jsonResponse({ objects: { id: "1" } }));

    await tagObject("503", "Invoice", ["TestTagGamma"]);
    await tagObject("504", "Invoice", ["TestTagGamma"]);

    // 1 lookup + 2 relation creates, not 2 lookups + 2 relation creates.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
