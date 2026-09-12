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
      intent: listing.intent,
      price: listing.price,
      currency: listing.currency,
      countryCode: listing.countryCode,
      city: listing.city,
      location: listing.location,
      status: listing.status,
      featured: listing.featured,
      sellerId: listing.seller.toString(),
      locationGeo:
        coords && coords.length === 2
          ? { lat: coords[1], lon: coords[0] }
          : undefined,
      createdAt: listing.createdAt,
    },
  });
}

export async function removeListingFromIndex(id: string): Promise<void> {
  if (!enabled || !client) return;
  try {
    await client.delete({ index: INDEX, id });
  } catch {
    // ignore missing docs
  }
}
