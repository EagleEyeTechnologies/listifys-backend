/**
 * Spot-check counts on newlistifysdb after migrate.
 * Uses SOURCE_MONGODB_URI / MONGODB_URI and TARGET_DB_NAME (default newlistifysdb).
 */
import "dotenv/config";
import { MongoClient } from "mongodb";

function withDbName(uri: string, dbName: string): string {
  try {
    const u = new URL(uri);
    u.pathname = `/${dbName}`;
    return u.toString();
  } catch {
    return uri.replace(/\/([^/?]+)(\?|$)/, `/${dbName}$2`);
  }
}

async function main() {
  const base =
    process.env.TARGET_MONGODB_URI ||
    process.env.SOURCE_MONGODB_URI ||
    process.env.MONGODB_URI;
  if (!base) {
    console.error("Need TARGET_MONGODB_URI or SOURCE_MONGODB_URI or MONGODB_URI");
    process.exit(1);
  }
  const dbName = process.env.TARGET_DB_NAME || "newlistifysdb";
  const uri = withDbName(base, dbName);
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  for (const n of [
    "users",
    "listings",
    "conversations",
    "messages",
    "notifications",
  ]) {
    console.log(`${n}: ${await db.collection(n).countDocuments()}`);
  }

  const cats = await db
    .collection("listings")
    .aggregate([
      { $group: { _id: "$category", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ])
    .toArray();
  console.log("categories:", cats);

  const needsReview = await db.collection("listings").countDocuments({
    "_migrationMeta.needsCountryReview": true,
  });
  console.log("listings needing country review:", needsReview);

  const sample = await db.collection("listings").findOne(
    {},
    {
      projection: {
        title: 1,
        category: 1,
        countryCode: 1,
        city: 1,
        "_migrationMeta.sourceCollection": 1,
      },
    },
  );
  console.log("sample:", sample);

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
