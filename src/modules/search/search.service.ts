import { Client } from "@elastic/elasticsearch";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import type { ListingDocument } from "../listings/listing.model.js";

let client: Client | null = null;
let enabled = false;

const INDEX = "listifys-listings";

export async function connectElasticsearch(): Promise<void> {
  const node = (env.ELASTICSEARCH_URL || "").trim().replace(/^["']|["']$/g, "");
  if (!node) {
    logger.info("ELASTICSEARCH_URL not set — search index stubs are no-ops");
    return;
  }

  client = new Client({
    node,
    auth:
      env.ELASTIC_USERNAME && env.ELASTIC_PASSWORD
        ? {
            username: env.ELASTIC_USERNAME.trim().replace(/^["']|["']$/g, ""),
            password: env.ELASTIC_PASSWORD.trim().replace(/^["']|["']$/g, ""),
          }
        : undefined,
  });

  try {
    await client.ping();
    enabled = true;
    logger.info("Elasticsearch connected");
  } catch (err) {
    enabled = false;
    client = null;
    logger.warn("Elasticsearch ping failed — index stubs disabled", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export function elasticsearchReady(): boolean {
  return enabled;
}

export async function indexListing(listing: ListingDocument): Promise<void> {
  if (!enabled || !client) return;
  const coords = listing.coordinates?.coordinates;
  await client.index({
    index: INDEX,
    id: listing._id.toString(),
    document: {
      title: listing.title,
      description: listing.description,
      category: listing.category,
      subcategory: listing.subcategory,
      subSubcategory: listing.subSubcategory,
      ...searchableExtras(listing),
      intent: listing.intent,
      price: listing.price,
      currency: listing.currency,
      countryCode: listing.countryCode,
      city: listing.city,
      location: listing.location,
      status: listing.status,
      featured: listing.featured,
      sellerId: listing.seller.toString(),
      locationGeo: coords && coords.length === 2 ? { lat: coords[1], lon: coords[0] } : undefined,
      createdAt: listing.createdAt,
    },
  });
}

function searchableExtras(listing: ListingDocument) {
  const extras = (listing.extras || {}) as Record<string, unknown>;
  const colors: string[] = [];
  const brands: string[] = [];
  for (const key of ["vehicle", "fashion", "electronics", "mobile", "furniture"]) {
    const bag = extras[key];
    if (!bag || typeof bag !== "object") continue;
    const row = bag as Record<string, unknown>;
    if (row.color) colors.push(String(row.color));
    if (row.brand) brands.push(String(row.brand));
  }
  return {
    color: colors.join(" "),
    brand: brands.join(" "),
  };
}

/** Ranked listing ids when Elasticsearch is up. Null means the caller should use MongoDB. */
export async function searchListingIds(q: string, countryCode: string): Promise<string[] | null> {
  const query = q.trim();
  if (!enabled || !client || !query) return null;
  try {
    const result = await client.search({
      index: INDEX,
      size: 200,
      query: {
        bool: {
          filter: [{ term: { countryCode } }, { term: { status: "active" } }],
          must: {
            multi_match: {
              query,
              fields: [
                "title^4",
                "description",
                "category^2",
                "subcategory^2",
                "subSubcategory^2",
                "color^3",
                "brand^2",
                "city",
                "location",
              ],
              fuzziness: "AUTO",
              operator: "and",
            },
          },
        },
      },
    });
    const hits = result.hits?.hits || [];
    return hits.map((hit) => String(hit._id)).filter(Boolean);
  } catch (err) {
    logger.warn("Elasticsearch query failed — using database search", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function removeListingFromIndex(id: string): Promise<void> {
  if (!enabled || !client) return;
  try {
    await client.delete({ index: INDEX, id });
  } catch {
    // ignore missing docs
  }
}
