#!/usr/bin/env node
// Read-only SevDesk audit — plan.md §7 step 1.
// Run: node --env-file=.env scripts/audit-sevdesk.mjs
//
// Answers plan.md §6 open items 1, 2, 3, 5, 8. Makes NO writes.
// Never prints contact names/emails/addresses/phone numbers — only invoice
// metadata (id, number, date, note, tax fields) needed to answer the open items.

const token = process.env.SEVDESK_API_TOKEN;
if (!token) {
  console.error("SEVDESK_API_TOKEN not set (expected via .env)");
  process.exit(1);
}

const BASE = "https://my.sevdesk.de/api/v1";

async function sevGet(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: token },
  });
  const rateHeaders = {};
  for (const h of ["x-ratelimit-limit", "x-ratelimit-remaining", "retry-after"]) {
    if (res.headers.has(h)) rateHeaders[h] = res.headers.get(h);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${path} -> ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  return { data: json.objects ?? json, rateHeaders, status: res.status };
}

function shapeOfNote(note) {
  if (note == null || note === "") return "(empty)";
  if (/^\d+$/.test(note)) return `all-digits, len ${note.length}`;
  if (/^#?\d+$/.test(note)) return `shopify-order-like, len ${note.length}`;
  return `free-text, len ${note.length}`;
}

async function main() {
  console.log("=== SevDesk read-only audit ===\n");

  // 1) Pull a batch of invoices, newest first.
  const { data: invoices, rateHeaders } = await sevGet("/Invoice", {
    limit: 100,
    orderBy: "invoiceDate DESC",
  });
  console.log(`Fetched ${invoices.length} invoices (most recent first).`);
  if (Object.keys(rateHeaders).length) {
    console.log("Rate-limit headers observed:", rateHeaders);
  } else {
    console.log("No rate-limit headers observed on this response.");
  }

  // 2) customerInternalNote occupancy + shape (plan.md open item #1)
  const withNote = invoices.filter((inv) => inv.customerInternalNote);
  console.log(
    `\ncustomerInternalNote populated on ${withNote.length}/${invoices.length} invoices.`,
  );
  const shapes = new Map();
  for (const inv of invoices) {
    const s = shapeOfNote(inv.customerInternalNote);
    shapes.set(s, (shapes.get(s) ?? 0) + 1);
  }
  console.log("Shape distribution:", Object.fromEntries(shapes));
  console.log(
    "Sample notes (order-ref-only, no customer data):",
    withNote.slice(0, 5).map((inv) => inv.customerInternalNote),
  );

  // 3) tax regime: taxType (1.0) vs taxRule (2.0) (plan.md open item #2)
  const taxTypeCount = invoices.filter((inv) => inv.taxType != null).length;
  const taxRuleCount = invoices.filter((inv) => inv.taxRule != null).length;
  console.log(
    `\nTax regime: taxType present on ${taxTypeCount}/${invoices.length}, taxRule present on ${taxRuleCount}/${invoices.length}.`,
  );
  const taxTypeValues = new Set(invoices.map((inv) => inv.taxType).filter(Boolean));
  const taxRuleValues = new Set(invoices.map((inv) => inv.taxRule).filter(Boolean));
  console.log("Distinct taxType values:", [...taxTypeValues]);
  console.log("Distinct taxRule values:", [...taxRuleValues]);

  // 4) invoice-level custom fields (plan.md open item #3, nice-to-have)
  const withCustomFields = invoices.filter(
    (inv) => Array.isArray(inv.customFields) && inv.customFields.length > 0,
  );
  console.log(
    `\nInvoices with non-empty customFields array: ${withCustomFields.length}/${invoices.length}.`,
  );
  if (invoices[0]) {
    console.log("Top-level keys on an Invoice object:", Object.keys(invoices[0]).sort());
  }

  // 5) most recent Shopify-sourced invoice, for the manual cutoff timestamp (plan.md §3.3 / open item #8)
  const shopifyLike = invoices.filter((inv) => shapeOfNote(inv.customerInternalNote).startsWith("shopify-order-like") || shapeOfNote(inv.customerInternalNote).startsWith("all-digits"));
  if (shopifyLike.length) {
    const mostRecent = shopifyLike[0];
    console.log(
      `\nMost recent invoice with an order-number-shaped note: invoiceDate=${mostRecent.invoiceDate}, invoiceNumber=${mostRecent.invoiceNumber}, id=${mostRecent.id}, status=${mostRecent.status}`,
    );
  } else {
    console.log("\nNo invoices with an order-number-shaped customerInternalNote found in this batch.");
  }

  // 6) total invoice count, for backfill volume estimate (plan.md open item #5)
  try {
    const { data: countData } = await sevGet("/Invoice/Factory/getNextInvoiceNumber", {}).catch(() => ({ data: null }));
    void countData;
  } catch {
    // best-effort only
  }
  console.log(
    "\n(For total historical volume, see the invoice count shown in the SevDesk UI — the API's count endpoint shape wasn't verified here to avoid extra calls.)",
  );

  console.log("\n=== Audit complete. No writes performed. ===");
}

main().catch((err) => {
  console.error("Audit failed:", err.message);
  process.exit(1);
});
