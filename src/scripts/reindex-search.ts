/**
 * Push every listing from MongoDB into Meilisearch (removed listings are deleted from the index).
 * Reads MongoDB only. Run after first configuring MEILISEARCH_HOST, or any time the index drifts.
 * Usage: npx tsx src/scripts/reindex-search.ts
 */
import { connectMongo } from "../db/mongo.js";
import { Listing, type ListingDocument } from "../modules/listings/listing.model.js";
import { connectSearch, indexListings, searchReady } from "../modules/search/search.service.js";
import { logger } from "../utils/logger.js";
import mongoose from "mongoose";

const BATCH = 500;

async function main() {
  await connectSearch();
  if (!searchReady()) {
    throw new Error("Meilisearch is not reachable — check MEILISEARCH_HOST / MEILISEARCH_API_KEY");
  }
  await connectMongo();

  let total = 0;
  let batch: ListingDocument[] = [];
  for await (const doc of Listing.find({}).cursor()) {
    batch.push(doc as ListingDocument);
    if (batch.length >= BATCH) {
      await indexListings(batch, { wait: true });
      total += batch.length;
      batch = [];
      logger.info("Reindex progress", { total });
    }
  }
  if (batch.length) {
    await indexListings(batch, { wait: true });
    total += batch.length;
  }

  logger.info("Search reindex complete", { total });
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
