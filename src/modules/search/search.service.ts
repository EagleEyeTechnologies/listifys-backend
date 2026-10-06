import { Meilisearch, type Index } from "meilisearch";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { isUsablePoint } from "../../utils/geo.js";
import type { ListingDocument } from "../listings/listing.model.js";

type SearchDocument = {
  id: string;
  title: string;
  description: string;
  category: string;
  subcategory: string;
  subSubcategory: string;
  color: string;
  brand: string;
  intent: string;
  price: number;
  currency: string;
  countryCode: string;
  city: string;
  location: string;
  status: string;
  featured: boolean;
  sellerId: string;
  createdAt: number;
  _geo?: { lat: number; lng: number };
};

/** Settings + document writes; generous timeout because the first TLS connect can be slow. */
let index: Index<SearchDocument> | null = null;
/** Queries sit on the request path, so they fail fast and MongoDB answers instead. */
let searchIndex: Index<SearchDocument> | null = null;
let enabled = false;

function cleanEnv(value?: string) {
  return (value || "").trim().replace(/^["']|["']$/g, "");
}

const RETRY_MS = 60_000;
let retryTimer: NodeJS.Timeout | null = null;

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void setupSearch().then((ok) => {
      if (!ok) scheduleRetry();
    });
  }, RETRY_MS);
  retryTimer.unref();
}

/** Tries a few times, then keeps retrying in the background so a network blip doesn't disable search until restart. */
export async function connectSearch(): Promise<void> {
  if (!cleanEnv(env.MEILISEARCH_HOST)) {
    logger.info("MEILISEARCH_HOST not set — search indexing is a no-op, MongoDB search is used");
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (await setupSearch(attempt === 3)) return;
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  scheduleRetry();
}

async function setupSearch(logFailure = true): Promise<boolean> {
  const host = cleanEnv(env.MEILISEARCH_HOST);
  const apiKey = cleanEnv(env.MEILISEARCH_API_KEY) || undefined;
  const uid = cleanEnv(env.MEILISEARCH_INDEX) || "listifys-listings";

  try {
    const nextIndex = new Meilisearch({ host, apiKey, timeout: 30_000 }).index<SearchDocument>(uid);
    // Idempotent; also creates the index on first boot.
    await nextIndex.updateSettings({
      searchableAttributes: [
        "title",
        "brand",
        "color",
        "category",
        "subcategory",
        "subSubcategory",
        "description",
        "city",
        "location",
      ],
      filterableAttributes: [
        "countryCode",
        "status",
        "category",
        "intent",
        "featured",
        "sellerId",
        "price",
        "_geo",
      ],
      sortableAttributes: ["createdAt", "price", "_geo"],
      synonyms: {
        tv: ["television", "tvs"],
        tvs: ["tv", "television"],
        television: ["tv"],
        scooter: ["bike"],
        motorcycle: ["bike"],
        couch: ["sofa"],
        sofa: ["couch"],
        fridge: ["refrigerator"],
        refrigerator: ["fridge"],
      },
    });
    index = nextIndex;
    searchIndex = new Meilisearch({ host, apiKey, timeout: 5000 }).index<SearchDocument>(uid);
    enabled = true;
    logger.info("Meilisearch connected", { host });
    return true;
  } catch (err) {
    if (logFailure) {
      logger.warn("Meilisearch unavailable — using MongoDB search, retrying in background", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  }
}

export function searchReady(): boolean {
  return enabled;
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

function toSearchDocument(listing: ListingDocument): SearchDocument {
  const coords = listing.coordinates?.coordinates;
  const doc: SearchDocument = {
    id: listing._id.toString(),
    title: listing.title,
    description: listing.description,
    category: listing.category,
    subcategory: listing.subcategory || "",
    subSubcategory: listing.subSubcategory || "",
    ...searchableExtras(listing),
    intent: listing.intent || "sale",
    price: listing.price,
    currency: listing.currency || "",
    countryCode: listing.countryCode,
    city: listing.city,
    location: listing.location,
    status: listing.status,
    featured: Boolean(listing.featured),
    sellerId: listing.seller.toString(),
    createdAt: new Date(listing.createdAt || Date.now()).getTime(),
  };
  if (coords && coords.length === 2 && isUsablePoint(coords[1], coords[0])) {
    doc._geo = { lat: coords[1]!, lng: coords[0]! };
  }
  return doc;
}

/** Upsert listings; removed ones are dropped from the index. Resolves once Meilisearch has queued the work. */
export async function indexListings(listings: ListingDocument[], opts?: { wait?: boolean }) {
  if (!enabled || !index || !listings.length) return;
  const live = listings.filter((l) => l.status !== "removed");
  const removed = listings.filter((l) => l.status === "removed").map((l) => l._id.toString());
  if (live.length) {
    const task = index.addDocuments(live.map(toSearchDocument), { primaryKey: "id" });
    if (opts?.wait) await task.waitTask({ timeout: 120_000 });
    else await task;
  }
  if (removed.length) {
    const task = index.deleteDocuments(removed);
    if (opts?.wait) await task.waitTask({ timeout: 120_000 });
    else await task;
  }
}

/** Runs in the background so saving a listing never waits on the search service. */
export async function indexListing(listing: ListingDocument): Promise<void> {
  void indexListings([listing]).catch((err) => {
    logger.warn("Meilisearch index update failed — run search:reindex to catch up", {
      id: listing._id.toString(),
      err: err instanceof Error ? err.message : String(err),
    });
  });
}

/** Ranked listing ids when Meilisearch is up. Null means the caller should use MongoDB. */
export async function searchListingIds(q: string, countryCode: string): Promise<string[] | null> {
  const query = q.trim();
  if (!enabled || !searchIndex || !query) return null;
  try {
    const result = await searchIndex.search(query, {
      filter: [`countryCode = ${JSON.stringify(countryCode)}`, `status = "active"`],
      limit: 200,
      attributesToRetrieve: ["id"],
      // Every word must match (typos allowed), same as the MongoDB fallback.
      matchingStrategy: "all",
    });
    return result.hits.map((hit) => String(hit.id)).filter(Boolean);
  } catch (err) {
    logger.warn("Meilisearch query failed — using database search", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function removeListingFromIndex(id: string): Promise<void> {
  if (!enabled || !index) return;
  void index.deleteDocument(id).catch(() => {
    // ignore missing docs
  });
}
