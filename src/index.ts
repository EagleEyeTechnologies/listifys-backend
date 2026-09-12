import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { connectMongo } from "./db/mongo.js";
import { connectRedis, redisBackend } from "./redis/client.js";
import { connectElasticsearch } from "./modules/search/search.service.js";
import { initQueues } from "./queues/listingQueue.js";
import { initSocket } from "./modules/chat/socket.js";
import { initFcm, fcmReady } from "./modules/notifications/fcm.service.js";
import { logger } from "./utils/logger.js";
import http from "http";

async function main() {
  await connectMongo();
  await connectRedis();
  initQueues();
  await connectElasticsearch();
  initFcm();

  const app = createApp();
  const server = http.createServer(app);
  initSocket(server);

  server.listen(env.PORT, "0.0.0.0", () => {
    logger.info(`listifys-api listening on :${env.PORT}`, {
      env: env.NODE_ENV,
      clientUrl: env.CLIENT_URL,
      socket: true,
      redis: redisBackend(),
      fcm: fcmReady(),
      s3: Boolean(env.AWS_S3_BUCKET_NAME && env.AWS_ACCESS_KEY_ID),
      elasticsearch: Boolean(env.ELASTICSEARCH_URL),
    });
  });
}

main().catch((err) => {
  logger.error("Failed to start API", {
    err: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
