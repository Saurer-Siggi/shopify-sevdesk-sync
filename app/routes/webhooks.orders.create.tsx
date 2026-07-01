import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const orderId = String(payload.id);
  const orderName = String(payload.name);

  console.log(`Received ${topic} webhook for ${shop}, order ${orderId}`);

  await db.syncItem.create({
    data: {
      shop,
      shopifyOrderId: orderId,
      shopifyOrderName: orderName,
      topic: "orders/create",
    },
  });

  return new Response();
};
