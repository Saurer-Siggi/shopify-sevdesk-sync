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
import { listSevUsers, listTaxRules } from "../sevdesk/client.server";

const CUSTOMER_CATEGORY_ID = "3";
const CUSTOMER_CATEGORY_LABEL = "Kunde (customer)";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await db.syncSettings.upsert({
    where: { shop },
    update: {},
    create: { shop, syncEnabled: false },
  });

  const currencyResponse = await admin.graphql(`#graphql
    query ShopCurrency { shop { currencyCode } }
  `);
  const { data } = await currencyResponse.json();
  const shopifyCurrency = data.shop.currencyCode as string;

  let sevUsers: { id: string; fullname: string }[] = [];
  let taxRules: { id: string; name: string }[] = [];
  let sevdeskLoadError = false;
  try {
    [sevUsers, taxRules] = await Promise.all([listSevUsers(), listTaxRules()]);
  } catch {
    sevdeskLoadError = true;
  }

  // One-time migration convenience: the old env-var-only config, offered as a pre-fill suggestion only.
  // eslint-disable-next-line no-undef
  const contactPersonIdSuggestion = process.env.SEVDESK_CONTACT_PERSON_ID ?? null;

  return {
    sevdeskContactPersonId: settings.sevdeskContactPersonId,
    sevdeskTaxRuleId: settings.sevdeskTaxRuleId,
    sevdeskCategoryId: settings.sevdeskCategoryId,
    invoiceStatus: settings.invoiceStatus,
    currency: settings.currency,
    shopifyCurrency,
    sevUsers,
    taxRules,
    sevdeskLoadError,
    contactPersonIdSuggestion,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "save") {
    const sevdeskContactPersonId = String(
      formData.get("sevdeskContactPersonId") ?? "",
    );
    const sevdeskTaxRuleId = String(formData.get("sevdeskTaxRuleId") ?? "");
    const sevdeskCategoryId = String(formData.get("sevdeskCategoryId") ?? "");
    const invoiceStatus = String(formData.get("invoiceStatus") ?? "");
    const currency = String(formData.get("currency") ?? "");

    if (invoiceStatus !== "100" && invoiceStatus !== "1000") {
      throw new Response("Invalid invoice status", { status: 400 });
    }

    await db.syncSettings.upsert({
      where: { shop },
      update: {
        sevdeskContactPersonId,
        sevdeskTaxRuleId,
        sevdeskCategoryId,
        invoiceStatus,
        currency,
      },
      create: {
        shop,
        syncEnabled: false,
        sevdeskContactPersonId,
        sevdeskTaxRuleId,
        sevdeskCategoryId,
        invoiceStatus,
        currency,
      },
    });

    return { intent: "save", ok: true };
  }

  throw new Response("Unknown intent", { status: 400 });
};

export default function Settings() {
  const {
    sevdeskContactPersonId,
    sevdeskTaxRuleId,
    sevdeskCategoryId,
    invoiceStatus,
    currency,
    shopifyCurrency,
    sevUsers,
    taxRules,
    sevdeskLoadError,
    contactPersonIdSuggestion,
  } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const saveFetcher = useFetcher<typeof action>();

  const isSaving = saveFetcher.state !== "idle";

  useEffect(() => {
    if (saveFetcher.data?.intent === "save" && saveFetcher.data.ok) {
      shopify.toast.show("Settings saved");
    }
  }, [saveFetcher.data, shopify]);

  const submitSettings = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set("intent", "save");
    saveFetcher.submit(form, { method: "POST" });
  };

  const contactPersonDefault =
    sevdeskContactPersonId ??
    contactPersonIdSuggestion ??
    sevUsers[0]?.id ??
    "";
  const taxRuleDefault = sevdeskTaxRuleId ?? "1";
  const categoryDefault = sevdeskCategoryId ?? CUSTOMER_CATEGORY_ID;
  const invoiceStatusDefault = invoiceStatus ?? "100";
  const currencyDefault = currency ?? shopifyCurrency;

  return (
    <s-page heading="SevDesk settings">
      {sevdeskLoadError && (
        <s-banner tone="warning" heading="Couldn't load live SevDesk options">
          <s-paragraph>
            The list of SevDesk users and tax rules couldn&apos;t be fetched
            right now. You can still fill in the fields below manually —
            enter the SevDesk id directly as text.
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Sync configuration">
        <form onSubmit={submitSettings}>
          <s-stack direction="block" gap="base">
            {!sevdeskLoadError && sevUsers.length > 0 ? (
              <s-select
                name="sevdeskContactPersonId"
                label="Invoice contact person"
                value={contactPersonDefault}
              >
                {sevUsers.map((user) => (
                  <s-option key={user.id} value={user.id}>
                    {user.fullname}
                  </s-option>
                ))}
              </s-select>
            ) : (
              <input
                type="text"
                name="sevdeskContactPersonId"
                aria-label="Invoice contact person (SevDesk user id)"
                defaultValue={contactPersonDefault}
                placeholder="SevDesk user id"
              />
            )}

            {!sevdeskLoadError && taxRules.length > 0 ? (
              <s-select
                name="sevdeskTaxRuleId"
                label="Tax rule"
                value={taxRuleDefault}
              >
                {taxRules.map((rule) => (
                  <s-option key={rule.id} value={rule.id}>
                    {rule.name}
                  </s-option>
                ))}
              </s-select>
            ) : (
              <input
                type="text"
                name="sevdeskTaxRuleId"
                aria-label="Tax rule (SevDesk tax rule id)"
                defaultValue={taxRuleDefault}
                placeholder="SevDesk tax rule id"
              />
            )}

            <s-select
              name="sevdeskCategoryId"
              label="Customer category"
              value={categoryDefault}
            >
              <s-option value={CUSTOMER_CATEGORY_ID}>
                {CUSTOMER_CATEGORY_LABEL}
              </s-option>
            </s-select>

            <s-choice-list
              name="invoiceStatus"
              label="Invoice status"
              values={[invoiceStatusDefault]}
            >
              <s-choice value="100">Draft</s-choice>
              <s-choice value="1000">Open</s-choice>
            </s-choice-list>

            <input
              type="text"
              name="currency"
              aria-label="Currency"
              defaultValue={currencyDefault}
            />

            <s-button type="submit" {...(isSaving ? { loading: true } : {})}>
              Save settings
            </s-button>
          </s-stack>
        </form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
