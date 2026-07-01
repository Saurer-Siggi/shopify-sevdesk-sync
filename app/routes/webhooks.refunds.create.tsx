import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  // Refund payloads carry order_id only; worker resolves the display name itself.
  const orderId = String(payload.order_id);

  console.log(`Received ${topic} webhook for ${shop}, order ${orderId}`);

  await db.syncItem.create({
    data: {
      shop,
      shopifyOrderId: orderId,
      shopifyOrderName: orderId,
      topic: "refunds/create",
    },
  });

  return new Response();
};
