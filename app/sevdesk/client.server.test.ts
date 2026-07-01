import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCreditNoteForOrder,
  createInvoiceForOrder,
  findInvoicesByOrderName,
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
  process.env.SEVDESK_CONTACT_PERSON_ID = "42";
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
      lineItems: [
        { name: "Kräuterlikör 0,7l", quantity: 2, unitPriceGross: 19.99, taxRatePercent: 19 },
        { name: "Bio-Apfelsaft 1l", quantity: 1, unitPriceGross: 3.49, taxRatePercent: 7 },
      ],
    });

    expect(result).toEqual({ id: "1001", invoiceNumber: "RN-2026-2000" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/Invoice/Factory/saveInvoice");
    const body = JSON.parse(init.body as string);

    expect(body.invoice.customerInternalNote).toBe("#1050");
    expect(body.invoice.taxRule).toEqual({ id: "1", objectName: "TaxRule" });
    expect(body.invoice.contact).toEqual({ id: "501", objectName: "Contact" });
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
      lineItems: [
        { name: "Kräuterlikör 0,7l", quantity: 1, unitPriceGross: 19.99, taxRatePercent: 19 },
      ],
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
    });

    expect(result).toEqual({ id: "2001" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/CreditNote/Factory/saveCreditNote");
    const body = JSON.parse(init.body as string);

    expect(body.creditNote.customerInternalNote).toBe("#1050");
    expect(body.creditNote.refSrcInvoice).toEqual({
      id: "1001",
      objectName: "Invoice",
    });
    expect(body.creditNotePosSave).toHaveLength(1);
    expect(body.creditNotePosSave[0]).toMatchObject({
      name: "Kräuterlikör 0,7l",
      quantity: 1,
      price: 19.99,
      taxRate: 19,
    });
  });
});
