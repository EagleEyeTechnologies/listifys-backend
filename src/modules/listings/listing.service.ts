import { z } from "zod";
import mongoose from "mongoose";
import { Listing } from "./listing.model.js";
import { ListingView } from "./listingView.model.js";
import { User } from "../users/user.model.js";
import { CATEGORY_SLUGS } from "../../types/domain.js";
import { AppError } from "../../utils/AppError.js";
import { distanceMiles, isUsablePoint, placeNameRegex } from "../../utils/geo.js";
import { geocodeAddress } from "../places/places.service.js";
import {
  indexListing,
  removeListingFromIndex,
  searchListingIds,
} from "../search/search.service.js";
import { enqueueListingSideEffect } from "../../queues/listingQueue.js";
import { notifyFollowersOfNewListing } from "./listingFollowers.js";
import { isMongoObjectId, listingSlugFrom } from "../../utils/slug.js";
import { absolutizeMediaUrl } from "../../utils/mediaUrl.js";
import { hiddenSellerIds, isEitherBlocked } from "../users/users.service.js";
import { kv } from "../../redis/client.js";
import { eventStartFromExtras, isEventPastFromExtras } from "../event-tickets/eventDate.js";
import { computeInventory, syncEventInventory } from "../event-tickets/eventInventory.js";
import { normalizeRefundPolicy } from "../event-tickets/refundPolicy.js";

const LISTINGS_CACHE_VER = "listings:catalog-ver";
const LISTINGS_CACHE_TTL = 90;
// Each Upstash call is an HTTPS round trip, so hot browse results and the catalog version
// are also kept in process briefly. Other instances pick up a new version within VERSION_L1_MS.
const VERSION_L1_MS = 5_000;
const RESULTS_L1_MS = 20_000;
const RESULTS_L1_MAX = 300;

let versionL1: { value: string; at: number } | null = null;
const resultsL1 = new Map<string, { value: unknown; expiresAt: number }>();

async function listingsCacheVersion() {
  if (versionL1 && Date.now() - versionL1.at < VERSION_L1_MS) return versionL1.value;
  const value = (await kv.get(LISTINGS_CACHE_VER)) || "0";
  versionL1 = { value, at: Date.now() };
  return value;
}

async function invalidateListingsCache() {
  const value = String(Date.now());
  versionL1 = { value, at: Date.now() };
  resultsL1.clear();
  await kv.set(LISTINGS_CACHE_VER, value, 60 * 60 * 24);
}

function readResultsL1<T>(key: string): T | undefined {
  const row = resultsL1.get(key);
  if (!row) return undefined;
  if (Date.now() > row.expiresAt) {
    resultsL1.delete(key);
    return undefined;
  }
  return row.value as T;
}

function writeResultsL1(key: string, value: unknown) {
  if (resultsL1.size >= RESULTS_L1_MAX) {
    const oldest = resultsL1.keys().next().value;
    if (oldest !== undefined) resultsL1.delete(oldest);
  }
  resultsL1.set(key, { value, expiresAt: Date.now() + RESULTS_L1_MS });
}

let lastEventSweepAt = 0;

/** Move events whose start time has passed from Active to Completed (stored as expired). */
async function sweepEndedEvents() {
  const now = Date.now();
  if (now - lastEventSweepAt < 15_000) return;
  lastEventSweepAt = now;
  const rows = await Listing.find({ category: "events", status: "active" }).limit(500);
  const ids = rows
    .filter((row) => isEventPastFromExtras(row.extras, row.countryCode))
    .map((row) => row._id);
  if (!ids.length) return;
  await Listing.updateMany(
    { _id: { $in: ids }, status: "active" },
    { $set: { status: "expired" } },
  );
  void invalidateListingsCache();
}

export const createListingSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(10).max(10000),
  category: z.enum(CATEGORY_SLUGS),
  subcategory: z.string().optional(),
  subSubcategory: z.string().optional(),
  intent: z.enum(["sale", "wanted", "free"]).optional(),
  price: z.number().finite().min(0).max(999_999_999_999),
  currency: z.string().optional(),
  condition: z.string().optional(),
  images: z.array(z.string().min(1)).max(20).optional(),
  video: z.string().max(2000).optional(),
  location: z.string().min(2),
  city: z.string().min(2),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  featured: z.boolean().optional(),
  extras: z.record(z.unknown()).optional(),
});

function eventStartIsUpcoming(extras: Record<string, unknown>, countryCode?: string) {
  const start = eventStartFromExtras(extras, countryCode);
  if (!start) return false;
  const now = new Date();
  now.setSeconds(0, 0);
  start.setSeconds(0, 0);
  return start.getTime() >= now.getTime();
}

/** Store only a well-formed refund policy on events. */
function withCleanRefundPolicy(extras?: Record<string, unknown>) {
  const event = extras?.event;
  if (!extras || !event || typeof event !== "object" || !("refundPolicy" in event)) return extras;
  return {
    ...extras,
    event: {
      ...(event as Record<string, unknown>),
      refundPolicy: normalizeRefundPolicy((event as Record<string, unknown>).refundPolicy),
    },
  };
}

function assertEventFields(
  input: { category?: string; extras?: Record<string, unknown> },
  countryCode?: string,
) {
  if (input.category !== "events") return;
  if (!input.extras) {
    throw new AppError(400, "Event start time, venue, and duration are required", "VALIDATION");
  }
  const event =
    input.extras.event && typeof input.extras.event === "object"
      ? (input.extras.event as Record<string, unknown>)
      : {};
  const startsAt = String(event.startsAt || "").trim();
  const venue = String(event.venue || "").trim();
  const duration = String(event.duration || "").trim();
  if (!startsAt || !eventStartIsUpcoming(input.extras, countryCode)) {
    throw new AppError(400, "Choose an event start time in the future", "VALIDATION");
  }
  if (!venue) throw new AppError(400, "Event venue is required", "VALIDATION");
  if (!duration) throw new AppError(400, "Event duration is required", "VALIDATION");
}

export const updateListingSchema = createListingSchema.partial().extend({
  status: z.enum(["active", "sold", "paused", "expired"]).optional(),
});

export const listQuerySchema = z.object({
  category: z.enum(CATEGORY_SLUGS).optional(),
  intent: z.enum(["sale", "wanted", "free"]).optional(),
  type: z.string().optional(),
  city: z.string().optional(),
  /** Most specific name of the place being browsed (e.g. "Uppal"); matches ads without a map pin. */
  place: z.string().max(120).optional(),
  q: z.string().optional(),
  status: z.enum(["active", "sold", "paused", "expired", "removed"]).optional().default("active"),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  radiusMiles: z.coerce.number().min(1).max(500).optional(),
  sort: z
    .enum(["latest", "oldest", "price-asc", "price-desc", "nearest"])
    .optional()
    .default("latest"),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(500).default(20),
  sellerId: z.string().optional(),
});

function normalizeImages(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .flatMap((v) => normalizeImages(v))
      .map((s) => s.trim())
      .filter(Boolean)
      .map(absolutizeMediaUrl);
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (/\s+https?:\/\//i.test(trimmed) || trimmed.includes(" ")) {
      return trimmed
        .split(/\s+/)
        .map((s) => s.trim())
        .filter((s) => /^https?:\/\//i.test(s) || s.startsWith("/"))
        .map(absolutizeMediaUrl);
    }
    return [absolutizeMediaUrl(trimmed)];
  }
  return [];
}

function listingPublicSlug(doc: InstanceType<typeof Listing>) {
  if (doc.slug) return doc.slug;
  const generated = listingSlugFrom(doc.title, doc._id.toString());
  doc.slug = generated;
  // Avoid doc.save() here — it races with other saves on the same document
  // (ParallelSaveError). Persist via updateOne so callers can save freely.
  void Listing.updateOne(
    { _id: doc._id, $or: [{ slug: null }, { slug: "" }, { slug: { $exists: false } }] },
    { $set: { slug: generated } },
  ).catch(() => undefined);
  return generated;
}

function toPublic(doc: InstanceType<typeof Listing>) {
  const obj = doc.toObject();
  const raw = obj.coordinates?.coordinates;
  const coords = raw && isUsablePoint(raw[1], raw[0]) ? raw : undefined;
  const images = normalizeImages(obj.images);
  const sellerId = obj.seller?.toString?.() || String(obj.seller);
  return {
    id: doc._id.toString(),
    slug: listingPublicSlug(doc),
    title: obj.title,
    description: obj.description,
    category: obj.category,
    subcategory: obj.subcategory,
    subSubcategory: obj.subSubcategory,
    intent: obj.intent,
    price: obj.price,
    currency: obj.currency,
    countryCode: obj.countryCode,
    condition: obj.condition,
    images,
    image: images[0] || "",
    video: typeof obj.video === "string" ? absolutizeMediaUrl(obj.video) : "",
    location: obj.location,
    city: obj.city,
    lat: coords?.[1],
    lng: coords?.[0],
    sellerId,
    sellerName: obj.sellerName,
    sellerAvatar: absolutizeMediaUrl(obj.sellerAvatar),
    status: obj.status,
    featured: obj.featured,
    views: obj.views,
    extras: obj.extras || {},
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
}

/** Seller's pin when usable, otherwise a geocode of the typed address so radius browse can find the ad. */
async function resolveListingPoint(
  input: { lat?: number; lng?: number; location?: string; city?: string },
  countryCode: string,
) {
  if (isUsablePoint(input.lat, input.lng)) {
    return { type: "Point" as const, coordinates: [input.lng!, input.lat!] };
  }
  const address = [input.location, input.city].filter(Boolean).join(", ");
  const found = address ? await geocodeAddress(address, countryCode) : null;
  return found ? { type: "Point" as const, coordinates: [found.lng, found.lat] } : undefined;
}

function currencyFor(countryCode: "US" | "CA" | "IN") {
  if (countryCode === "US") return "USD";
  if (countryCode === "CA") return "CAD";
  return "INR";
}

export async function createListing(
  sellerId: string,
  countryCode: "US" | "CA" | "IN",
  input: z.infer<typeof createListingSchema>,
) {
  const seller = await User.findById(sellerId);
  if (!seller) throw new AppError(401, "Seller not found", "UNAUTHORIZED");
  assertEventFields(input, countryCode);

  const id = new mongoose.Types.ObjectId();
  const slug = listingSlugFrom(input.title, id.toString());
  const coordinates = await resolveListingPoint(input, countryCode);

  const listing = await Listing.create({
    _id: id,
    ...input,
    slug,
    currency: currencyFor(countryCode),
    countryCode,
    images: input.images || [],
    seller: seller._id,
    sellerName: seller.name || "",
    sellerAvatar: seller.avatar || "",
    intent: input.intent || "sale",
    extras: withCleanRefundPolicy(input.extras) || {},
    coordinates,
  });
  if (listing.category === "events") {
    await syncEventInventory(listing._id);
    const synced = await Listing.findById(listing._id);
    if (synced) listing.set(synced.toObject());
  }

  try {
    await indexListing(listing);
  } catch {
    /* listing is saved; search index can catch up later */
  }
  await enqueueListingSideEffect("created", listing._id.toString());
  void invalidateListingsCache();
  void notifyFollowersOfNewListing({
    sellerId,
    sellerName: seller.name || "",
    listingId: listing._id.toString(),
    title: listing.title,
    image: listing.images?.[0],
  });
  return toPublic(listing);
}

async function recordUniqueView(
  listingId: mongoose.Types.ObjectId,
  sellerId: string,
  viewerId?: string,
  anonViewerId?: string,
) {
  if (viewerId && viewerId === sellerId) return false;
  const raw = (viewerId ? `user:${viewerId}` : anonViewerId ? `anon:${anonViewerId}` : "").slice(
    0,
    120,
  );
  if (!raw) return false;
  try {
    await ListingView.create({ listing: listingId, viewerKey: raw });
    return true;
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 11000) return false;
    return false;
  }
}

export async function getListingById(idOrSlug: string, viewerId?: string, anonViewerId?: string) {
  const key = String(idOrSlug || "").trim();
  if (!key) throw new AppError(404, "Listing not found", "NOT_FOUND");

  let listing: InstanceType<typeof Listing> | null = null;
  if (isMongoObjectId(key)) {
    listing = await Listing.findById(key);
  }
  if (!listing) {
    listing = await Listing.findOne({ slug: key.toLowerCase() });
  }
  // Before/during slug backfill: resolve `title-slug-{last6}` via ObjectId suffix
  if (!listing) {
    const short = key.match(/-([a-f0-9]{6})$/i)?.[1]?.toLowerCase();
    if (short) {
      listing = await Listing.findOne({
        status: { $ne: "removed" },
        $expr: {
          $eq: [{ $substrCP: [{ $toString: "$_id" }, 18, 6] }, short],
        },
      });
    }
  }
  if (!listing || listing.status === "removed") {
    throw new AppError(404, "Listing not found", "NOT_FOUND");
  }
  if (
    listing.category === "events" &&
    listing.status === "active" &&
    isEventPastFromExtras(listing.extras, listing.countryCode)
  ) {
    listing.status = "expired";
    await listing.save();
    void invalidateListingsCache();
  }
  if (listing.status === "paused" && viewerId !== listing.seller.toString()) {
    throw new AppError(404, "Listing not found", "NOT_FOUND");
  }
  // Prefer live seller avatar/name (denormalized fields can be stale/empty)
  const [blocked, seller] = await Promise.all([
    viewerId ? isEitherBlocked(viewerId, listing.seller.toString()) : false,
    User.findById(listing.seller).select("avatar name").lean(),
  ]);
  if (blocked) {
    throw new AppError(404, "Listing not found", "NOT_FOUND");
  }

  const patch: Record<string, unknown> = {};
  if (!listing.slug) patch.slug = listingSlugFrom(listing.title, listing._id.toString());
  if (seller?.avatar && seller.avatar !== listing.sellerAvatar) patch.sellerAvatar = seller.avatar;
  if (seller?.name && seller.name !== listing.sellerName) patch.sellerName = seller.name;

  const firstView = await recordUniqueView(
    listing._id,
    listing.seller.toString(),
    viewerId,
    anonViewerId,
  );
  const update: Record<string, unknown> = {};
  if (firstView) update.$inc = { views: 1 };
  if (Object.keys(patch).length) update.$set = patch;
  const updated = Object.keys(update).length
    ? await Listing.findByIdAndUpdate(listing._id, update, { new: true })
    : listing;
  if (!updated) throw new AppError(404, "Listing not found", "NOT_FOUND");
  const payload = toPublic(updated);
  if (payload.category === "events") {
    const inventory = await computeInventory(updated);
    const extras =
      payload.extras && typeof payload.extras === "object"
        ? { ...(payload.extras as Record<string, unknown>) }
        : {};
    const event =
      extras.event && typeof extras.event === "object"
        ? { ...(extras.event as Record<string, unknown>) }
        : {};
    event.ticketsSold = inventory.sold;
    event.ticketsAvailable = inventory.left ?? 0;
    event.soldOut = inventory.soldOut;
    if (inventory.total != null) event.ticketsTotal = inventory.total;
    if (Array.isArray(event.tickets)) {
      event.tickets = (event.tickets as Record<string, unknown>[]).map((t, i) => {
        const inv = inventory.tiers[i];
        return inv ? { ...t, id: inv.id, sold: inv.sold, left: inv.left } : t;
      });
    }
    extras.event = event;
    payload.extras = extras;
  }
  return payload;
}

export async function updateListing(
  id: string,
  sellerId: string,
  input: z.infer<typeof updateListingSchema>,
) {
  const listing = await Listing.findById(id);
  if (!listing || listing.status === "removed") {
    throw new AppError(404, "Listing not found", "NOT_FOUND");
  }
  if (listing.seller.toString() !== sellerId) {
    throw new AppError(403, "Not listing owner", "FORBIDDEN");
  }
  if (input.extras) {
    assertEventFields(
      {
        category: input.category || listing.category,
        extras: input.extras,
      },
      listing.countryCode,
    );
  }

  const $set: Record<string, unknown> = {};
  const fields = [
    "title",
    "description",
    "category",
    "subcategory",
    "subSubcategory",
    "intent",
    "price",
    "condition",
    "images",
    "video",
    "location",
    "city",
    "featured",
    "extras",
    "status",
  ] as const;
  for (const key of fields) {
    if (input[key] !== undefined) $set[key] = input[key];
  }
  if (input.extras) $set.extras = withCleanRefundPolicy(input.extras);
  if (input.currency !== undefined) {
    $set.currency = currencyFor(listing.countryCode as "US" | "CA" | "IN");
  }
  const placeChanged =
    (input.location !== undefined && input.location !== listing.location) ||
    (input.city !== undefined && input.city !== listing.city);
  if (isUsablePoint(input.lat, input.lng) || placeChanged) {
    const point = await resolveListingPoint(
      {
        lat: input.lat,
        lng: input.lng,
        location: input.location ?? listing.location,
        city: input.city ?? listing.city,
      },
      listing.countryCode,
    );
    if (point) $set.coordinates = point;
  }
  const staleCoordinates = placeChanged && !$set.coordinates;

  let updated = await Listing.findOneAndUpdate(
    { _id: listing._id, seller: sellerId, status: { $ne: "removed" } },
    staleCoordinates ? { $set, $unset: { coordinates: 1 } } : { $set },
    { new: true },
  );
  if (!updated) {
    throw new AppError(404, "Listing not found", "NOT_FOUND");
  }
  if (updated.category === "events" && input.extras) {
    await syncEventInventory(updated._id);
    updated = (await Listing.findById(updated._id)) || updated;
  }
  try {
    await indexListing(updated);
  } catch {
    /* status already persisted; search index can lag */
  }
  await enqueueListingSideEffect("updated", updated._id.toString());
  void invalidateListingsCache();
  return toPublic(updated);
}

export async function softDeleteListing(id: string, sellerId: string) {
  const listing = await Listing.findById(id);
  if (!listing || listing.status === "removed") {
    throw new AppError(404, "Listing not found", "NOT_FOUND");
  }
  if (listing.seller.toString() !== sellerId) {
    throw new AppError(403, "Not listing owner", "FORBIDDEN");
  }
  listing.status = "removed";
  await listing.save();
  await removeListingFromIndex(id);
  await enqueueListingSideEffect("removed", id);
  void invalidateListingsCache();
  return { id };
}

export async function countListingsByCategory(countryCode: "US" | "CA" | "IN") {
  await sweepEndedEvents();
  const rows = await Listing.aggregate<{ _id: string; count: number }>([
    { $match: { status: "active", countryCode } },
    { $group: { _id: "$category", count: { $sum: 1 } } },
  ]);
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row._id) counts[String(row._id)] = row.count;
  }
  return counts;
}

export async function listMyListings(sellerId: string) {
  await sweepEndedEvents();
  const rows = await Listing.find({
    seller: sellerId,
    status: { $ne: "removed" },
  })
    .sort({ createdAt: -1 })
    .limit(1000);
  return {
    items: rows.map(toPublic),
    page: 1,
    limit: rows.length,
    total: rows.length,
    totalPages: 1,
  };
}

export async function browseListings(
  countryCode: "US" | "CA" | "IN",
  query: z.infer<typeof listQuerySchema>,
  viewerId?: string,
) {
  // Housekeeping only; it invalidates the cache itself when it expires an event.
  void sweepEndedEvents().catch(() => undefined);
  const version = await listingsCacheVersion();
  const cacheKey = `listings:${version}:${countryCode}:${viewerId || "anon"}:${JSON.stringify(query)}`;
  type BrowseResult = Awaited<ReturnType<typeof browseListingsUncached>>;
  const local = readResultsL1<BrowseResult>(cacheKey);
  if (local) return local;
  try {
    const hit = await kv.get(cacheKey);
    if (hit) {
      const parsed = JSON.parse(hit) as BrowseResult;
      writeResultsL1(cacheKey, parsed);
      return parsed;
    }
  } catch {
    /* cache miss or corrupt payload */
  }
  const result = await browseListingsUncached(countryCode, query, viewerId);
  writeResultsL1(cacheKey, result);
  void kv.set(cacheKey, JSON.stringify(result), LISTINGS_CACHE_TTL).catch(() => undefined);
  return result;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Everyday words that sellers spell differently in titles and subcategories. */
const KEYWORD_SYNONYMS: Record<string, string[]> = {
  tv: ["television"],
  television: ["tv"],
  automobile: ["car"],
  scooter: ["bike"],
  scooty: ["bike"],
  motorcycle: ["bike"],
  motorbike: ["bike"],
  couch: ["sofa"],
  sofa: ["couch"],
  smartphone: ["phone"],
  cellphone: ["phone"],
  fridge: ["refrigerator"],
  refrigerator: ["fridge"],
  notebook: ["laptop"],
};

/** Short words ("tv") must start a word, or they match inside unrelated ones. */
function keywordPattern(form: string) {
  const escaped = escapeRegex(form);
  return form.length <= 3 ? `\\b${escaped}` : escaped;
}

/** Every word must match a title, description, category, place, color, or brand. */
async function applyKeywordSearch(
  filter: Record<string, unknown>,
  q: string,
  countryCode: "US" | "CA" | "IN",
) {
  const indexed = await searchListingIds(q, countryCode);

  const tokens = q
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
  const words = tokens.length ? tokens : [q];
  const clauses = words.map((word) => {
    const lower = word.toLowerCase();
    const forms = [lower];
    if (lower.length > 3 && lower.endsWith("s") && !lower.endsWith("ss")) {
      forms.push(lower.slice(0, -1));
    }
    for (const form of [...forms]) forms.push(...(KEYWORD_SYNONYMS[form] || []));
    const rx = new RegExp([...new Set(forms)].map(keywordPattern).join("|"), "i");
    return {
      $or: [
        { title: rx },
        { description: rx },
        { category: rx },
        { subcategory: rx },
        { subSubcategory: rx },
        { city: rx },
        { location: rx },
        { "extras.vehicle.color": rx },
        { "extras.vehicle.brand": rx },
        { "extras.fashion.color": rx },
        { "extras.fashion.brand": rx },
        { "extras.electronics.brand": rx },
        { "extras.mobile.brand": rx },
        { "extras.furniture.brand": rx },
        { "extras.furniture.color": rx },
      ],
    };
  });
  const existing = Array.isArray(filter.$and) ? filter.$and : [];
  if (indexed && indexed.length) {
    filter.$and = [...existing, { $or: [{ _id: { $in: indexed } }, { $and: clauses }] }];
    return;
  }
  filter.$and = [...existing, ...clauses];
}

async function browseListingsUncached(
  countryCode: "US" | "CA" | "IN",
  query: z.infer<typeof listQuerySchema>,
  viewerId?: string,
) {
  await sweepEndedEvents();
  const viewingOwnListings = Boolean(viewerId) && query.sellerId === viewerId;
  const filter: Record<string, unknown> = {
    status: viewingOwnListings ? query.status || "active" : "active",
  };
  // Seller public profile: show all markets for that seller (don't hide by browse country)
  if (query.sellerId && mongoose.isValidObjectId(query.sellerId)) {
    filter.seller = query.sellerId;
  } else {
    filter.countryCode = countryCode;
  }
  const hiddenSellers = await hiddenSellerIds(viewerId);
  if (hiddenSellers.length) {
    const requested =
      typeof filter.seller === "string"
        ? filter.seller
        : filter.seller && typeof filter.seller === "object" && "toString" in filter.seller
          ? String(filter.seller)
          : "";
    if (requested && hiddenSellers.some((id) => id.toString() === requested)) {
      return {
        items: [],
        page: query.page,
        limit: query.limit,
        total: 0,
        totalPages: 0,
      };
    }
    if (!requested) filter.seller = { $nin: hiddenSellers };
  }
  if (query.category) filter.category = query.category;
  if (query.intent) filter.intent = query.intent;
  const cityName = query.city?.trim();
  const placeRx = query.place ? placeNameRegex(query.place) : null;
  const placeText = placeRx ? { $or: [{ city: placeRx }, { location: placeRx }] } : null;
  const useGeo =
    query.lat !== undefined &&
    query.lng !== undefined &&
    (query.radiusMiles !== undefined || query.sort === "nearest");
  const radiusSearch = useGeo && Boolean(query.radiusMiles);
  // A radius search must not also require an exact city, or nearby ads in
  // neighboring localities disappear. Unpinned ads are matched by place name below.
  if (!radiusSearch) {
    if (placeText) {
      filter.$and = [...((filter.$and as unknown[]) || []), placeText];
    } else if (cityName) {
      filter.city = new RegExp(`^${escapeRegex(cityName)}$`, "i");
    }
  }
  if (query.q) {
    const q = query.q.trim();
    if (isMongoObjectId(q)) filter._id = q;
    else await applyKeywordSearch(filter, q, countryCode);
  }

  // type alias used by UI: rentals => property deal types in extras
  if (query.type === "rentals") {
    filter.category = "properties";
    filter["extras.property.dealType"] = {
      $in: ["rent", "pg", "roommate"],
    };
  } else if (query.type === "wanted") {
    filter.intent = "wanted";
  } else if (query.type === "free") {
    filter.intent = "free";
  }

  const page = query.page;
  const limit = query.limit;
  const skip = (page - 1) * limit;

  let sort: Record<string, 1 | -1> = { createdAt: -1 };
  if (query.sort === "oldest") sort = { createdAt: 1 };
  if (query.sort === "price-asc") sort = { price: 1 };
  if (query.sort === "price-desc") sort = { price: -1 };

  if (radiusSearch) {
    const withinRadius = {
      coordinates: {
        $geoWithin: {
          $centerSphere: [[query.lng, query.lat], query.radiusMiles! / 3958.8],
        },
      },
    };
    const unpinned = {
      $or: [
        { coordinates: { $exists: false } },
        { coordinates: null },
        { "coordinates.coordinates": { $exists: false } },
        { "coordinates.coordinates": [0, 0] },
      ],
    };
    // Ads without a usable pin can't be measured, so they only show when their
    // address names the place being browsed. Older clients that don't send
    // `place` keep the previous behaviour of showing every unpinned ad.
    filter.$or = [withinRadius, placeText ? { $and: [unpinned, placeText] } : unpinned];
  }

  const [rows, total] = await Promise.all([
    Listing.find(filter)
      .sort(query.sort === "nearest" ? { createdAt: -1 } : sort)
      .skip(skip)
      .limit(limit),
    Listing.countDocuments(filter),
  ]);

  let items = rows.map((row) => ({
    ...toPublic(row),
    distanceMiles: undefined as number | undefined,
  }));

  if (query.lat !== undefined && query.lng !== undefined) {
    items = items.map((item) => {
      if (item.lat === undefined || item.lng === undefined) return item;
      return {
        ...item,
        distanceMiles: Number(distanceMiles(query.lat!, query.lng!, item.lat, item.lng).toFixed(1)),
      };
    });
    if (query.sort === "nearest") {
      items = items.sort((a, b) => (a.distanceMiles ?? 1e9) - (b.distanceMiles ?? 1e9));
    }
  }

  return {
    items,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}
