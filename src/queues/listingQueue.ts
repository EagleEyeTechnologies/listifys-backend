import { Queue } from "bullmq";
import { getRedis } from "../redis/client.js";
import { logger } from "../utils/logger.js";

let emailQueue: Queue | null = null;
let listingQueue: Queue | null = null;

export function initQueues() {
  const connection = getRedis();
  if (!connection) {
    logger.warn("BullMQ queues disabled (no Redis)");
    return;
  }

  emailQueue = new Queue("email", { connection });
  listingQueue = new Queue("listing-side-effects", { connection });
  logger.info("BullMQ queues ready");
}

export async function enqueueEmail(job: { to: string; subject: string; body: string }) {
  if (!emailQueue) {
    logger.info("email job (no queue)", job);
    return;
  }
  await emailQueue.add("send", job, { removeOnComplete: 100, removeOnFail: 50 });
}

export async function enqueueListingSideEffect(
  action: "created" | "updated" | "removed",
  listingId: string,
) {
  if (!listingQueue) {
    logger.debug("listing side-effect (no queue)", { action, listingId });
    return;
  }
  await listingQueue.add(
    action,
    { listingId, action },
    { removeOnComplete: 100, removeOnFail: 50 },
  );
}
