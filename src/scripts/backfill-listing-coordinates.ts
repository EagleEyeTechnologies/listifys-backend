/**
 * Geocode listings that have no map pin (or a broken [0, 0] pin) so radius
 * browse can find them.
 * Usage: npx tsx src/scripts/backfill-listing-coordinates.ts
 *        npx tsx src/scripts/backfill-listing-coordinates.ts --write
 */
import mongoose from "mongoose";
import { connectMongo } from "../db/mongo.js";
import { Listing } from "../modules/listings/listing.model.js";
import { geocodeAddress } from "../modules/places/places.service.js";
import { logger } from "../utils/logger.js";

const write = process.argv.includes("--write");

async function main() {
  await connectMongo();

  const rows = await Listing.find({
    status: { $ne: "removed" },
    $or: [
      { coordinates: { $exists: false } },
      { coordinates: null },
      { "coordinates.coordinates": { $exists: false } },
      { "coordinates.coordinates": [0, 0] },
    ],
  })
    .select({ title: 1, location: 1, city: 1, countryCode: 1 })
    .limit(20_000);

  let fixed = 0;
  const unresolved: string[] = [];
  for (const row of rows) {
    const address = [row.location, row.city].filter(Boolean).join(", ");
    const point = await geocodeAddress(address, row.countryCode);
    if (!point) {
      unresolved.push(`${row._id} ${address}`);
      continue;
    }
    fixed += 1;
    console.log(
      `${write ? "pin" : "would pin"} ${row._id} "${address}" -> ${point.lat},${point.lng}`,
    );
    if (write) {
      await Listing.updateOne(
        { _id: row._id },
        { $set: { coordinates: { type: "Point", coordinates: [point.lng, point.lat] } } },
      );
    }
  }

  if (unresolved.length) console.log("Could not geocode:\n" + unresolved.join("\n"));
  logger.info("Listing coordinate backfill", {
    write,
    needingPin: rows.length,
    geocoded: fixed,
    unresolved: unresolved.length,
  });
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
