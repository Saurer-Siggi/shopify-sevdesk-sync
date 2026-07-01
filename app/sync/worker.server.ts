import db from "../db.server";
import { processSyncItem } from "./processor.server";

const POLL_INTERVAL_MS = 15000;

export async function processQueueOnce(
  shop: string,
  limit = 5,
): Promise<number> {
  const settings = await db.syncSettings.findUnique({ where: { shop } });
  if (!settings?.syncEnabled) return 0;

  const items = await db.syncItem.findMany({
    where: { shop, status: "pending" },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  for (const item of items) {
    await db.syncItem.update({
      where: { id: item.id },
      data: { status: "processing" },
    });
    await processSyncItem(item);
  }

  return items.length;
}

declare global {
  // eslint-disable-next-line no-var
  var __syncWorkerStarted: boolean | undefined;
}

let tickInProgress = false;

async function tick(): Promise<void> {
  if (tickInProgress) return;
  tickInProgress = true;
  try {
    const enabledShops = await db.syncSettings.findMany({
      where: { syncEnabled: true },
    });
    for (const { shop } of enabledShops) {
      await processQueueOnce(shop);
    }
  } catch (error) {
    console.error(`Sync worker tick failed: ${String(error)}`);
  } finally {
    tickInProgress = false;
  }
}

if (!global.__syncWorkerStarted) {
  global.__syncWorkerStarted = true;
  // A crash/redeploy mid-item leaves it stuck at "processing" forever (the
  // worker only ever picks up "pending", and it's not eligible for the UI's
  // retry button). Reprocessing is safe: SevDesk's dedup check is what makes
  // this idempotent, not the queue status.
  void db.syncItem
    .updateMany({
      where: { status: "processing" },
      data: { status: "pending" },
    })
    .catch((error: unknown) => {
      console.error(`Failed to reset stuck sync items on startup: ${String(error)}`);
    });
  setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
}
