/**
 * Backfill listing + user SEO slugs.
 * Usage: npx tsx src/scripts/backfill-slugs.ts
 *        npx tsx src/scripts/backfill-slugs.ts --write
 */
import { connectMongo } from "../db/mongo.js";
import { Listing } from "../modules/listings/listing.model.js";
import { User } from "../modules/users/user.model.js";
import { listingSlugFrom, sellerSlugFrom } from "../utils/slug.js";
import { logger } from "../utils/logger.js";
import mongoose from "mongoose";

const write = process.argv.includes("--write");

async function main() {
  await connectMongo();

  let listingUpdated = 0;
  let userUpdated = 0;

  const listings = await Listing.find({
    $or: [{ slug: { $exists: false } }, { slug: "" }, { slug: null }],
  }).limit(20_000);
  for (const doc of listings) {
    const slug = listingSlugFrom(doc.title, doc._id.toString());
    listingUpdated += 1;
    if (write) {
      doc.slug = slug;
      try {
        await doc.save();
      } catch {
        doc.slug = `${slug}-${doc._id.toString().slice(-4)}`;
        await doc.save();
      }
    }
  }

  const users = await User.find({
    $or: [{ slug: { $exists: false } }, { slug: "" }, { slug: null }],
  }).limit(20_000);
  for (const doc of users) {
    const slug = sellerSlugFrom(doc.name || "seller", doc._id.toString());
    userUpdated += 1;
    if (write) {
      doc.slug = slug;
      try {
        await doc.save();
      } catch {
        doc.slug = `${slug}-${doc._id.toString().slice(-4)}`;
        await doc.save();
      }
    }
  }

  logger.info("Slug backfill", {
    write,
    listingsNeedingSlug: listingUpdated,
    usersNeedingSlug: userUpdated,
  });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
