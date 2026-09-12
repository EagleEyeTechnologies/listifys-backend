import { Worker } from "bullmq";
import { connectRedis, getRedis } from "./redis/client.js";
import { logger } from "./utils/logger.js";

async function main() {
  await connectRedis();
  const connection = getRedis();
  if (!connection) {
    logger.error("Worker requires REDIS_URL");
    process.exit(1);
  }

  const emailWorker = new Worker(
    "email",
    async (job) => {
      logger.info("email job processed (stub)", { id: job.id, data: job.data });
    },
    { connection },
  );

  const listingWorker = new Worker(
    "listing-side-effects",
    async (job) => {
      logger.info("listing side-effect processed (stub)", {
        id: job.id,
        name: job.name,
        data: job.data,
      });
    },
    { connection },
  );

  emailWorker.on("failed", (job, err) => {
    logger.error("email job failed", { id: job?.id, err: err.message });
  });
  listingWorker.on("failed", (job, err) => {
    logger.error("listing job failed", { id: job?.id, err: err.message });
  });

  logger.info("BullMQ workers running (email, listing-side-effects)");
}

main().catch((err) => {
  logger.error("Worker failed to start", {
    err: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
