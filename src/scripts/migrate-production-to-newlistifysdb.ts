/**
 * Careful migration: MongoDB `production` → `newlistifysdb`
 *
 * - READ-ONLY on source (`production`)
 * - WRITES only to target (`newlistifysdb`)
 * - Default is dry-run; pass `--write` to apply
 * - Preserves `_id`s; idempotent upserts
 * - Unifies per-category listing collections → `listings`
 *
 * Usage:
 *   # Same Atlas cluster (recommended):
 *   SOURCE_MONGODB_URI="mongodb+srv://…/production?…" \
 *   TARGET_MONGODB_URI="mongodb+srv://…/newlistifysdb?…" \
 *     npm run migrate:prod
 *
 *   # Or one URI + explicit DB names:
 *   MONGODB_URI="mongodb+srv://…/" \
 *   SOURCE_DB_NAME=production TARGET_DB_NAME=newlistifysdb \
 *     npm run migrate:prod -- --write
 *
 *   npm run migrate:prod -- --write --collections=users,listings
 *   npm run migrate:prod -- --write --collections=addresses
 *   npm run migrate:prod -- --write --collections=sellerreviews
 *   npm run migrate:prod -- --write --limit=50
 */

import "dotenv/config";
import { MongoClient, ObjectId, type Db, type Document } from "mongodb";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../utils/logger.js";

function argvTokens(): string[] {
  const fromProcess = process.argv.slice(2);
  const fromNpm: string[] = [];
  // When someone runs `npm run migrate:prod --write`, npm sets npm_config_write
  // and may not forward --write to the script. Also parse npm_config_argv.remain.
  try {
    const npmArgv = JSON.parse(process.env.npm_config_argv || "{}") as {
      remain?: string[];
      original?: string[];
    };
    if (Array.isArray(npmArgv.remain)) fromNpm.push(...npmArgv.remain);
    if (Array.isArray(npmArgv.original)) fromNpm.push(...npmArgv.original);
  } catch {
    /* ignore */
  }
  if (process.env.npm_config_write === "true") fromNpm.push("--write");
  if (process.env.MIGRATE_WRITE === "1") fromNpm.push("--write");
  const collectionsEnv =
    process.env.npm_config_collections || process.env.MIGRATE_COLLECTIONS;
  if (collectionsEnv) fromNpm.push(`--collections=${collectionsEnv}`);
  return [...fromProcess, ...fromNpm];
}

const ARGV = argvTokens();

function hasFlag(name: string) {
  return ARGV.some((a) => a === name || a.startsWith(`${name}=`));
}

function getOpt(name: string): string | null {
  const eq = ARGV.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = ARGV.indexOf(name);
  if (i >= 0 && ARGV[i + 1] && !ARGV[i + 1]!.startsWith("-")) {
    return ARGV[i + 1]!;
  }
  return null;
}

const WRITE = hasFlag("--write") || hasFlag("-w");
const DRY_RUN = !WRITE;
const BATCH = Number(process.env.MIGRATE_BATCH_SIZE || 200);
const LIMIT = (() => {
  const raw = getOpt("--limit");
  return raw ? Number(raw) : 0;
})();
const ONLY = (() => {
  const raw = getOpt("--collections");
  if (!raw) return null as Set<string> | null;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
})();

console.log(
  `[migrate] argv=${JSON.stringify(ARGV)} write=${WRITE} only=${ONLY ? [...ONLY].join(",") : "(all)"}`,
);

const FORBIDDEN_TARGET_NAMES = new Set(["production", "admin", "local"]);

/** legacy collection → unified category slug */
const LISTING_SOURCES: {
  collection: string;
  category: string;
  extrasKey: string;
}[] = [
  { collection: "electronics", category: "electronics", extrasKey: "electronics" },
  { collection: "vehicles", category: "vehicles", extrasKey: "vehicles" },
  { collection: "mobiles", category: "mobiles", extrasKey: "mobiles" },
  { collection: "furnitures", category: "furniture", extrasKey: "furniture" },
  { collection: "fashions", category: "fashion", extrasKey: "fashion" },
  { collection: "toys", category: "toys", extrasKey: "toys" },
  { collection: "sports", category: "sports", extrasKey: "sports" },
  { collection: "collectibles", category: "collectibles", extrasKey: "collectibles" },
  { collection: "pets", category: "pets", extrasKey: "pets" },
  { collection: "books", category: "books", extrasKey: "books" },
  { collection: "beauties", category: "beauty", extrasKey: "beauty" },
  { collection: "others", category: "others", extrasKey: "others" },
  { collection: "forsales", category: "others", extrasKey: "forsale" },
  { collection: "properties", category: "properties", extrasKey: "property" },
  { collection: "jobs", category: "jobs", extrasKey: "job" },
  { collection: "events", category: "events", extrasKey: "event" },
  { collection: "servicelistings", category: "services", extrasKey: "service" },
  { collection: "takecares", category: "takecare", extrasKey: "takeCare" },
];

const SHARED_LISTING_KEYS = new Set([
  "_id",
  "__v",
  "title",
  "description",
  "price",
  "category",
  "subcategory",
  "subSubcategory",
  "sub_subcategory",
  "condition",
  "images",
  "location",
  "coordinates",
  "seller",
  "sellerName",
  "sellerRating",
  "sellerReviews",
  "sellerJoined",
  "sellerAvatar",
  "userId",
  "status",
  "featured",
  "views",
  "savedBy",
  "phone",
  "phoneCode",
  "currency",
  "countryCode",
  "deliveryOption",
  "allowCalls",
  "allowOffers",
  "allowExchange",
  "slug",
  "createdAt",
  "updatedAt",
  "needsCountryReview",
  "_migrationMeta",
  "intent",
  "type",
  "pricing",
  "providerId",
]);

type Stats = {
  read: number;
  written: number;
  skipped: number;
  errors: string[];
};

function want(name: string) {
  if (!ONLY) return true;
  if (ONLY.has(name)) return true;
  if (name === "listings" && ONLY.has("listings")) return true;
  return ONLY.has(name);
}

function dbNameFromUri(uri: string): string | null {
  try {
    const u = new URL(uri);
    const path = u.pathname.replace(/^\//, "");
    return path.split("?")[0] || null;
  } catch {
    const m = uri.match(/\.net\/([^?]+)/);
    return m?.[1] || null;
  }
}

function withDbName(uri: string, dbName: string): string {
  if (uri.includes("mongodb+srv://") || uri.startsWith("mongodb://")) {
    try {
      const u = new URL(uri);
      u.pathname = `/${dbName}`;
      return u.toString();
    } catch {
      return uri.replace(/\/([^/?]+)(\?|$)/, `/${dbName}$2`);
    }
  }
  return uri;
}

function inferCountryCode(doc: Document): {
  code: "US" | "CA" | "IN";
  confidence: string;
  needsReview?: boolean;
} {
  const existing = String(doc.countryCode || "")
    .trim()
    .toUpperCase();
  if (existing === "US" || existing === "CA" || existing === "IN") {
    return { code: existing, confidence: "explicit" };
  }

  const currency = String(doc.currency || "").trim();
  if (currency === "₹" || /^INR$/i.test(currency) || currency === "Rs") {
    return { code: "IN", confidence: "currency" };
  }
  if (currency === "C$" || /^CAD$/i.test(currency)) {
    return { code: "CA", confidence: "currency" };
  }
  if (currency === "$" || /^USD$/i.test(currency)) {
    return { code: "US", confidence: "currency-weak", needsReview: true };
  }

  const phone = String(doc.phoneCode || "").trim();
  if (phone === "+91") return { code: "IN", confidence: "phone" };
  if (phone === "+1") return { code: "US", confidence: "phone-weak", needsReview: true };

  const loc = String(
    typeof doc.location === "string"
      ? doc.location
      : doc.location?.address || doc.location?.city || "",
  ).toLowerCase();
  if (
    /\b(india|hyderabad|bengaluru|bangalore|mumbai|delhi|chennai|kolkata|pune|telangana|karnataka|maharashtra)\b/.test(
      loc,
    )
  ) {
    return { code: "IN", confidence: "location-text" };
  }
  if (
    /\b(canada|toronto|vancouver|montreal|calgary|ottawa|ontario|quebec|british columbia)\b/.test(
      loc,
    )
  ) {
    return { code: "CA", confidence: "location-text" };
  }
  if (
    /\b(usa|united states|new york|california|texas|florida|raleigh|morrisville|chicago|austin)\b/.test(
      loc,
    )
  ) {
    return { code: "US", confidence: "location-text" };
  }

  return { code: "US", confidence: "default", needsReview: true };
}

function normalizeCurrency(raw: unknown, country: "US" | "CA" | "IN"): string {
  const s = String(raw || "").trim();
  if (/^INR$/i.test(s) || s === "₹" || s === "Rs") return "INR";
  if (/^CAD$/i.test(s) || s === "C$") return "CAD";
  if (/^USD$/i.test(s) || s === "$") return "USD";
  if (country === "IN") return "INR";
  if (country === "CA") return "CAD";
  return "USD";
}

function normalizeImages(images: unknown): string[] {
  if (!Array.isArray(images)) return [];
  return images
    .map((img) => {
      if (typeof img === "string") return img;
      if (img && typeof img === "object" && typeof (img as { url?: string }).url === "string") {
        return (img as { url: string }).url;
      }
      return null;
    })
    .filter((x): x is string => Boolean(x));
}

function normalizeLocation(doc: Document): {
  location: string;
  city: string;
  coordinates?: { type: "Point"; coordinates: [number, number] };
} {
  let location = "";
  let city = "";
  let coordinates: { type: "Point"; coordinates: [number, number] } | undefined;

  if (typeof doc.location === "string") {
    location = doc.location.trim();
  } else if (doc.location && typeof doc.location === "object") {
    const loc = doc.location as Record<string, unknown>;
    location = String(
      loc.address ||
        [loc.city, loc.state, loc.pincode || loc.zip].filter(Boolean).join(", ") ||
        "",
    ).trim();
    city = String(loc.city || "").trim();
    const c =
      (loc.coordinates as { coordinates?: number[] } | number[] | undefined) ||
      undefined;
    if (Array.isArray(c) && c.length >= 2) {
      coordinates = {
        type: "Point",
        coordinates: [Number(c[0]), Number(c[1])],
      };
    } else if (
      c &&
      typeof c === "object" &&
      Array.isArray((c as { coordinates?: number[] }).coordinates)
    ) {
      const arr = (c as { coordinates: number[] }).coordinates;
      coordinates = {
        type: "Point",
        coordinates: [Number(arr[0]), Number(arr[1])],
      };
    }
  }

  if (
    !coordinates &&
    doc.coordinates &&
    typeof doc.coordinates === "object" &&
    Array.isArray((doc.coordinates as { coordinates?: number[] }).coordinates)
  ) {
    const arr = (doc.coordinates as { coordinates: number[] }).coordinates;
    if (arr.length >= 2) {
      coordinates = {
        type: "Point",
        coordinates: [Number(arr[0]), Number(arr[1])],
      };
    }
  }

  if (!city && location) {
    const parts = location.split(",").map((p) => p.trim()).filter(Boolean);
    city = parts.length >= 2 ? parts[parts.length - 2]! : parts[0] || "";
  }

  if (!location) location = city || "Unknown";
  if (!city) city = "Unknown";

  return { location, city, coordinates };
}

function inferIntent(doc: Document, category: string): "sale" | "wanted" | "free" {
  const raw = String(doc.intent || doc.type || "").toLowerCase();
  if (raw.includes("want")) return "wanted";
  if (raw.includes("free") || raw === "giveaway") return "free";
  const title = String(doc.title || "").toLowerCase();
  if (title.startsWith("wanted") || title.includes("looking for")) return "wanted";
  const price = Number(doc.price ?? doc.pricing?.basePrice ?? 0);
  if (price === 0 && category !== "jobs") return "free";
  return "sale";
}

function mapStatus(raw: unknown): string {
  const s = String(raw || "active").toLowerCase();
  if (s === "draft") return "paused";
  if (s === "rented") return "sold";
  if (["active", "sold", "paused", "expired", "removed"].includes(s)) return s;
  return "active";
}

function pickExtras(doc: Document, extrasKey: string): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  const vertical: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (SHARED_LISTING_KEYS.has(k)) continue;
    if (v === undefined || v === null || v === "") continue;
    vertical[k] = v;
  }

  // Normalize common property aliases
  if (extrasKey === "property") {
    if (vertical.squareFeet != null && vertical.areaSqft == null) {
      vertical.areaSqft = vertical.squareFeet;
    }
    const catLabel = String(doc.category || "").toLowerCase();
    if (catLabel.includes("rent")) vertical.dealType = "rent";
    else if (catLabel.includes("roommate")) vertical.dealType = "roommate";
    else vertical.dealType = vertical.dealType || "sale";
  }

  if (extrasKey === "service" && doc.pricing) {
    vertical.pricing = doc.pricing;
    if (doc.providerId) vertical.providerId = doc.providerId;
    if (doc.category) vertical.legacyCategoryId = doc.category;
  }

  if (Object.keys(vertical).length) extras[extrasKey] = vertical;
  extras.legacy = {
    collectionHint: extrasKey,
    phone: doc.phone || undefined,
    phoneCode: doc.phoneCode || undefined,
  };
  return extras;
}

function transformListing(
  doc: Document,
  meta: { collection: string; category: string; extrasKey: string },
): { ok: true; doc: Document } | { ok: false; reason: string } {
  const seller = doc.seller || doc.userId;
  if (!seller) return { ok: false, reason: "missing seller/userId" };

  const title = String(doc.title || "").trim();
  if (!title) return { ok: false, reason: "missing title" };

  const inferred = inferCountryCode(doc);
  const { location, city, coordinates } = normalizeLocation(doc);
  const priceRaw =
    doc.price ??
    (doc.pricing && typeof doc.pricing === "object"
      ? (doc.pricing as { basePrice?: number }).basePrice
      : 0);
  const price = Number(priceRaw);
  if (!Number.isFinite(price) || price < 0) {
    return { ok: false, reason: `invalid price: ${priceRaw}` };
  }

  const subcategory =
    typeof doc.subcategory === "string"
      ? doc.subcategory
      : String(doc.subcategory || "");

  const out: Document = {
    _id: doc._id,
    title,
    description: String(doc.description || title).trim().slice(0, 10000),
    category: meta.category,
    subcategory,
    subSubcategory: String(doc.subSubcategory || doc.sub_subcategory || ""),
    intent: inferIntent(doc, meta.category),
    price,
    currency: normalizeCurrency(doc.currency, inferred.code),
    countryCode: inferred.code,
    condition: String(doc.condition || ""),
    images: normalizeImages(doc.images),
    location,
    city,
    seller,
    sellerName: String(doc.sellerName || ""),
    sellerAvatar: String(doc.sellerAvatar || ""),
    status: mapStatus(doc.status),
    featured: Boolean(doc.featured),
    views: Number(doc.views || 0),
    extras: pickExtras(doc, meta.extrasKey),
    createdAt: doc.createdAt || new Date(),
    updatedAt: doc.updatedAt || new Date(),
    _migrationMeta: {
      sourceDb: "production",
      sourceCollection: meta.collection,
      inferredCountryConfidence: inferred.confidence,
      needsCountryReview: Boolean(inferred.needsReview),
      migratedAt: new Date(),
    },
  };

  if (coordinates) out.coordinates = coordinates;
  return { ok: true, doc: out };
}

function transformUser(doc: Document, savedIds: string[]): Document {
  const providers: { provider: string; providerId?: string }[] = [];
  const provider = String(doc.provider || "local");
  if (doc.email) {
    providers.push({
      provider: provider === "google" ? "google" : provider === "apple" ? "apple" : "email",
      providerId:
        doc.googleId || doc.appleId || String(doc.email).toLowerCase(),
    });
  }
  if (doc.phone) {
    providers.push({
      provider: "phone",
      providerId: String(doc.phone),
    });
  }
  if (doc.googleId && !providers.some((p) => p.provider === "google")) {
    providers.push({ provider: "google", providerId: String(doc.googleId) });
  }
  if (doc.appleId && !providers.some((p) => p.provider === "apple")) {
    providers.push({ provider: "apple", providerId: String(doc.appleId) });
  }

  const country = inferCountryCode(doc);
  const avatar =
    doc.profileImage ||
    doc.avatar ||
    doc.googleProfileImage ||
    doc.profileImageThumbnail ||
    "";

  const devices = Array.isArray(doc.devices)
    ? doc.devices.map((d: Document) => ({
        deviceId: String(d.deviceId || ""),
        platform: String(d.deviceType || d.platform || "unknown"),
        lastSeenAt: d.lastActive || d.lastSeenAt || undefined,
      }))
    : [];

  const out: Document = {
    _id: doc._id,
    name: String(doc.name || "User").trim(),
    avatar: String(avatar || ""),
    providers,
    countryCode: country.code,
    devices,
    savedListingIds: savedIds,
    compareListingIds: [],
    isActive: doc.isActive !== false && doc.deleted !== true,
    createdAt: doc.createdAt || new Date(),
    updatedAt: doc.updatedAt || new Date(),
    _migrationMeta: {
      sourceDb: "production",
      legacyRole: doc.role,
      migratedAt: new Date(),
    },
  };

  const email = doc.email ? String(doc.email).toLowerCase().trim() : "";
  const rawPhone = doc.phone ? String(doc.phone).trim() : "";
  const rawCode = doc.phoneCode ? String(doc.phoneCode).trim() : "";
  if (email) out.email = email;
  if (rawPhone || rawCode) {
    // Keep national digits in phone + dial code in phoneCode when possible
    const digits = rawPhone.replace(/\D/g, "");
    if (rawPhone.startsWith("+91") || (digits.length === 12 && digits.startsWith("91"))) {
      out.phoneCode = "+91";
      out.phone = digits.slice(-10);
    } else if (rawCode) {
      out.phoneCode = rawCode.startsWith("+") ? rawCode : `+${rawCode.replace(/\D/g, "")}`;
      out.phone = digits.length > 10 && digits.startsWith("91") ? digits.slice(-10) : digits || rawPhone;
    } else {
      out.phone = rawPhone;
    }
  }

  const location =
    (doc.address && String(doc.address).trim()) ||
    (doc.location && typeof doc.location === "string" && doc.location.trim()) ||
    (doc.location && typeof doc.location === "object"
      ? String(
          (doc.location as Document).address ||
            (doc.location as Document).city ||
            "",
        ).trim()
      : "") ||
    "";
  if (location) out.location = location;

  if (doc.password || doc.passwordHash) {
    out.passwordHash = doc.password || doc.passwordHash;
  }

  return out;
}

function transformAddress(doc: Document): Document | null {
  if (!doc.user || !doc.formattedAddress) return null;
  const coords = doc.coordinates?.coordinates;
  const out: Document = {
    _id: doc._id,
    user: doc.user,
    label: String(doc.label || "Other").trim() || "Other",
    receiverName: String(doc.receiverName || "").trim(),
    phone: String(doc.phone || "").trim(),
    houseNumber: String(doc.houseNumber || "").trim(),
    buildingName: String(doc.buildingName || "").trim(),
    floor: String(doc.floor || "").trim(),
    street: String(doc.street || "").trim(),
    landmark: String(doc.landmark || "").trim(),
    city: String(doc.city || "").trim(),
    state: String(doc.state || "").trim(),
    pincode: String(doc.pincode || "").trim(),
    formattedAddress: String(doc.formattedAddress).trim(),
    placeId: String(doc.placeId || "").trim(),
    deliveryInstructions: String(doc.deliveryInstructions || "").trim(),
    isDefault: Boolean(doc.isDefault),
    createdAt: doc.createdAt || new Date(),
    updatedAt: doc.updatedAt || new Date(),
    _migrationMeta: {
      sourceDb: "production",
      migratedAt: new Date(),
    },
  };
  if (
    Array.isArray(coords) &&
    coords.length === 2 &&
    Number.isFinite(Number(coords[0])) &&
    Number.isFinite(Number(coords[1]))
  ) {
    out.coordinates = {
      type: "Point",
      coordinates: [Number(coords[0]), Number(coords[1])],
    };
  }
  return out;
}

function mapNotificationType(
  raw: string,
): "message" | "listing" | "offer" | "promo" | "system" | "review" {
  if (raw === "message") return "message";
  if (raw.startsWith("offer") || raw === "offer_received") return "offer";
  if (raw === "review_received") return "review";
  if (raw === "price_drop" || raw === "engagement") return "promo";
  if (
    raw.startsWith("listing") ||
    raw === "new_listing" ||
    raw === "listing_saved" ||
    raw === "listing_sold"
  ) {
    return "listing";
  }
  return "system";
}

function transformNotification(doc: Document): Document | null {
  const user = doc.recipient || doc.user;
  if (!user) return null;
  const body = String(doc.message || doc.body || "").trim();
  if (!body) return null;
  const type = mapNotificationType(String(doc.type || "system"));
  const meta = (doc.metadata || {}) as Record<string, unknown>;
  return {
    _id: doc._id,
    user,
    type,
    title: String(doc.title || type).slice(0, 200),
    body: body.slice(0, 1000),
    href: String(meta.href || meta.link || ""),
    image: String(meta.image || ""),
    read: Boolean(doc.read),
    createdAt: doc.createdAt || new Date(),
    updatedAt: doc.updatedAt || new Date(),
    _migrationMeta: {
      sourceDb: "production",
      legacyType: doc.type,
      migratedAt: new Date(),
    },
  };
}

function transformSellerReview(doc: Document): Document | null {
  if (!doc.seller || !doc.reviewer) return null;
  const rating = Number(doc.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) return null;
  const comment = String(doc.comment || "").trim();
  if (comment.length < 10) return null;
  const status = ["published", "hidden", "flagged"].includes(
    String(doc.status || ""),
  )
    ? String(doc.status)
    : "published";
  return {
    _id: doc._id,
    seller: doc.seller,
    reviewer: doc.reviewer,
    listing: doc.listing || null,
    listingCategory: String(doc.listingCategory || ""),
    rating: Math.round(rating),
    title: String(doc.title || "").slice(0, 100),
    comment: comment.slice(0, 1000),
    status,
    createdAt: doc.createdAt || new Date(),
    updatedAt: doc.updatedAt || new Date(),
    _migrationMeta: {
      sourceDb: "production",
      sourceCollection: "sellerreviews",
      migratedAt: new Date(),
    },
  };
}

function transformConversation(doc: Document): Document {
  const listing = (doc.listing || {}) as Document;
  const listingId = listing.listingId || null;
  const listingType = String(listing.listingType || "others");
  const slug =
    listingType === "forsale"
      ? "others"
      : listingType === "rentals" || listingType === "roommates"
        ? "properties"
        : listingType;

  return {
    _id: doc._id,
    participants: doc.participants || [],
    listingId,
    listingTitle: String(listing.listingTitle || ""),
    listingImage: String(listing.listingImage || ""),
    listingPrice: Number(listing.listingPrice || 0),
    listingHref: listingId ? `/${slug}/${listingId}` : "/browse",
    lastMessageText: String(doc.lastMessageText || ""),
    lastMessageAt: doc.lastMessageAt || null,
    unreadBy: doc.unreadCounts || doc.unreadBy || {},
    createdAt: doc.createdAt || new Date(),
    updatedAt: doc.updatedAt || new Date(),
    _migrationMeta: {
      sourceDb: "production",
      legacyListingType: listing.listingType,
      migratedAt: new Date(),
    },
  };
}

function transformMessage(doc: Document): Document | null {
  let text = String(doc.content || doc.text || "").trim();
  if (!text && Array.isArray(doc.attachments) && doc.attachments.length) {
    text = "[attachment]";
  }
  if (!text && doc.kind === "system") {
    text = String(doc.systemType || "system");
  }
  if (!text) return null;
  if (!doc.conversation || !doc.sender) return null;

  return {
    _id: doc._id,
    conversation: doc.conversation,
    sender: doc.sender,
    text: text.slice(0, 5000),
    kind: doc.kind === "system" ? "system" : "text",
    readBy: Array.isArray(doc.readBy) ? doc.readBy : [],
    createdAt: doc.createdAt || new Date(),
    updatedAt: doc.updatedAt || new Date(),
    _migrationMeta: {
      sourceDb: "production",
      migratedAt: new Date(),
    },
  };
}

async function bulkUpsert(
  db: Db,
  collection: string,
  docs: Document[],
  stats: Stats,
) {
  if (!docs.length) return;
  stats.read += docs.length;
  if (DRY_RUN) {
    stats.written += docs.length;
    return;
  }
  const ops = docs.map((doc) => ({
    replaceOne: {
      filter: { _id: doc._id },
      replacement: doc,
      upsert: true,
    },
  }));
  try {
    const res = await db.collection(collection).bulkWrite(ops, { ordered: false });
    stats.written +=
      (res.upsertedCount || 0) + (res.modifiedCount || 0) + (res.matchedCount || 0);
  } catch (err) {
    stats.errors.push(
      `${collection}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function streamTransform(
  source: Db,
  target: Db,
  sourceCollection: string,
  targetCollection: string,
  transform: (doc: Document) => Document | null | { ok: false; reason: string } | { ok: true; doc: Document },
  stats: Stats,
  onEach?: (doc: Document, out: Document) => void,
) {
  const exists = await source.listCollections({ name: sourceCollection }).hasNext();
  if (!exists) {
    logger.info(`[${sourceCollection}] skip — missing in source`);
    return;
  }

  const total = await source.collection(sourceCollection).countDocuments();
  logger.info(`[${sourceCollection} → ${targetCollection}] ${total} docs`);

  const cursor = source
    .collection(sourceCollection)
    .find({})
    .batchSize(BATCH);
  if (LIMIT > 0) cursor.limit(LIMIT);

  let batch: Document[] = [];
  let processed = 0;

  const flush = async () => {
    if (!batch.length) return;
    await bulkUpsert(target, targetCollection, batch, stats);
    processed += batch.length;
    batch = [];
    process.stdout.write(`  … ${processed}/${LIMIT || total}\r`);
  };

  for await (const doc of cursor) {
    const result = transform(doc);
    if (result == null) {
      stats.skipped += 1;
      continue;
    }
    if (
      typeof result === "object" &&
      "ok" in result &&
      typeof (result as { ok: unknown }).ok === "boolean"
    ) {
      const tagged = result as
        | { ok: false; reason: string }
        | { ok: true; doc: Document };
      if (!tagged.ok) {
        stats.skipped += 1;
        if (stats.errors.length < 50) {
          stats.errors.push(
            `${sourceCollection}/${String(doc._id)}: ${tagged.reason}`,
          );
        }
        continue;
      }
      onEach?.(doc, tagged.doc);
      batch.push(tagged.doc);
    } else {
      const out = result as Document;
      onEach?.(doc, out);
      batch.push(out);
    }
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  console.log(
    `  done ${processed} written, ${stats.skipped} skipped${DRY_RUN ? " (dry-run)" : ""}`,
  );
}

async function collectSavedBy(source: Db): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  for (const { collection } of LISTING_SOURCES) {
    const exists = await source.listCollections({ name: collection }).hasNext();
    if (!exists) continue;
    const cursor = source
      .collection(collection)
      .find(
        { savedBy: { $exists: true, $ne: [] } },
        { projection: { _id: 1, savedBy: 1 } },
      )
      .batchSize(BATCH);
    for await (const doc of cursor) {
      const listingId = String(doc._id);
      const savedBy = Array.isArray(doc.savedBy) ? doc.savedBy : [];
      for (const uid of savedBy) {
        const key = String(uid);
        if (!map.has(key)) map.set(key, new Set());
        map.get(key)!.add(listingId);
      }
    }
  }
  return map;
}

async function main() {
  const sourceDbName = process.env.SOURCE_DB_NAME || "production";
  const targetDbName = process.env.TARGET_DB_NAME || "newlistifysdb";

  let sourceUri =
    process.env.SOURCE_MONGODB_URI ||
    process.env.MONGODB_URI ||
    "";
  let targetUri = process.env.TARGET_MONGODB_URI || "";

  if (!sourceUri) {
    console.error(
      "Set SOURCE_MONGODB_URI (or MONGODB_URI) pointing at the cluster that hosts `production`.",
    );
    process.exit(1);
  }

  // Always pin DB path from SOURCE_DB_NAME / TARGET_DB_NAME
  // (defaults: production → newlistifysdb). Avoids treating MONGODB_URI's
  // /newlistifysdb path as both source and target.
  sourceUri = withDbName(sourceUri, sourceDbName);
  if (!targetUri) {
    targetUri = withDbName(sourceUri, targetDbName);
  } else {
    targetUri = withDbName(targetUri, targetDbName);
  }

  const resolvedSourceName = dbNameFromUri(sourceUri) || sourceDbName;
  const resolvedTargetName = dbNameFromUri(targetUri) || targetDbName;

  if (FORBIDDEN_TARGET_NAMES.has(resolvedTargetName.toLowerCase())) {
    console.error(
      `Refusing to write to forbidden target DB "${resolvedTargetName}". Use newlistifysdb.`,
    );
    process.exit(1);
  }
  if (resolvedTargetName.toLowerCase() === "production") {
    console.error("Refusing to write to production.");
    process.exit(1);
  }
  if (resolvedSourceName.toLowerCase() !== "production") {
    console.warn(
      `Warning: source DB is "${resolvedSourceName}" (expected production). Continuing.`,
    );
  }
  if (sourceUri === targetUri && resolvedSourceName === resolvedTargetName) {
    console.error("Source and target must differ.");
    process.exit(1);
  }

  console.log(DRY_RUN ? "DRY RUN — no writes (pass --write to apply)" : "LIVE WRITE");
  console.log(`Source: ${resolvedSourceName}`);
  console.log(`Target: ${resolvedTargetName}`);
  if (ONLY) console.log(`Only: ${[...ONLY].join(", ")}`);
  if (LIMIT) console.log(`Limit per collection: ${LIMIT}`);

  const sourceClient = new MongoClient(sourceUri);
  const targetClient = new MongoClient(targetUri);
  await sourceClient.connect();
  await targetClient.connect();

  const source = sourceClient.db(resolvedSourceName);
  const target = targetClient.db(resolvedTargetName);

  const report: Record<string, Stats> = {};
  const mk = (name: string): Stats => {
    report[name] = { read: 0, written: 0, skipped: 0, errors: [] };
    return report[name];
  };

  // 1) savedBy → map for users
  let savedMap = new Map<string, Set<string>>();
  if (want("users") || want("listings")) {
    logger.info("Scanning savedBy arrays…");
    savedMap = await collectSavedBy(source);
    logger.info(`Saved links for ${savedMap.size} users`);
  }

  // 2) Users
  if (want("users")) {
    const stats = mk("users");
    await streamTransform(
      source,
      target,
      "users",
      "users",
      (doc) => {
        const ids = [...(savedMap.get(String(doc._id)) || [])];
        return transformUser(doc, ids);
      },
      stats,
    );
  }

  // 2b) Saved places (Home / Work / College, etc.)
  if (want("addresses")) {
    const stats = mk("addresses");
    await streamTransform(
      source,
      target,
      "addresses",
      "addresses",
      (doc) => transformAddress(doc),
      stats,
    );

    // Backfill user.location from default / newest address when empty
    if (!DRY_RUN) {
      const defaults = await target
        .collection("addresses")
        .aggregate<{
          _id: ObjectId;
          label?: string;
          city?: string;
          formattedAddress?: string;
        }>([
          { $sort: { isDefault: -1, updatedAt: -1 } },
          {
            $group: {
              _id: "$user",
              label: { $first: "$label" },
              city: { $first: "$city" },
              formattedAddress: { $first: "$formattedAddress" },
            },
          },
        ])
        .toArray();
      const ops = defaults.map((a) => {
        const loc =
          (a.label && a.city && `${a.label} · ${a.city}`) ||
          a.city ||
          a.formattedAddress ||
          "";
        return {
          updateOne: {
            filter: {
              _id: a._id,
              $or: [
                { location: { $exists: false } },
                { location: "" },
                { location: null },
              ],
            },
            update: { $set: { location: loc } },
          },
        };
      }).filter((op) => op.updateOne.update.$set.location);
      for (let i = 0; i < ops.length; i += BATCH) {
        await target
          .collection("users")
          .bulkWrite(ops.slice(i, i + BATCH), { ordered: false });
      }
    }
  }

  // 3) Listings (unified)
  if (want("listings")) {
    const stats = mk("listings");
    const seen = new Set<string>();
    for (const meta of LISTING_SOURCES) {
      await streamTransform(
        source,
        target,
        meta.collection,
        "listings",
        (doc) => {
          const id = String(doc._id);
          if (seen.has(id)) {
            return { ok: false, reason: "duplicate _id across collections" };
          }
          const result = transformListing(doc, meta);
          if (result.ok) seen.add(id);
          return result;
        },
        stats,
      );
    }
  }

  // 4) Conversations
  if (want("conversations")) {
    const stats = mk("conversations");
    await streamTransform(
      source,
      target,
      "conversations",
      "conversations",
      (doc) => transformConversation(doc),
      stats,
    );
  }

  // 5) Messages — fill lastMessageText on conversations when empty
  if (want("messages")) {
    const stats = mk("messages");
    const lastText = new Map<string, { text: string; at: Date }>();
    await streamTransform(
      source,
      target,
      "messages",
      "messages",
      (doc) => {
        const out = transformMessage(doc);
        if (out) {
          const cid = String(out.conversation);
          const at = new Date(out.createdAt as Date);
          const prev = lastText.get(cid);
          if (!prev || at > prev.at) {
            lastText.set(cid, { text: String(out.text), at });
          }
        }
        return out;
      },
      stats,
    );

    if (!DRY_RUN && lastText.size) {
      const ops = [...lastText.entries()].map(([id, v]) => ({
        updateOne: {
          filter: {
            _id: new ObjectId(id),
            $or: [
              { lastMessageText: { $in: ["", null] } },
              { lastMessageText: { $exists: false } },
            ],
          },
          update: {
            $set: {
              lastMessageText: v.text,
              lastMessageAt: v.at,
            },
          },
        },
      }));
      for (let i = 0; i < ops.length; i += BATCH) {
        await target
          .collection("conversations")
          .bulkWrite(ops.slice(i, i + BATCH), { ordered: false });
      }
    }
  }

  // 6) Notifications
  if (want("notifications")) {
    const stats = mk("notifications");
    await streamTransform(
      source,
      target,
      "notifications",
      "notifications",
      (doc) => transformNotification(doc),
      stats,
    );
  }

  // 7) Seller reviews
  if (want("sellerreviews") || want("reviews")) {
    const stats = mk("sellerreviews");
    await streamTransform(
      source,
      target,
      "sellerreviews",
      "sellerreviews",
      (doc) => transformSellerReview(doc),
      stats,
    );
  }

  // Indexes on target (safe to re-run)
  if (!DRY_RUN && (want("listings") || want("users"))) {
    try {
      await target.collection("listings").createIndexes([
        { key: { countryCode: 1, status: 1, category: 1 } },
        { key: { seller: 1, status: 1 } },
        { key: { coordinates: "2dsphere" } },
        { key: { title: "text", description: "text" } },
      ]);
    } catch (err) {
      console.warn(
        "listings indexes:",
        err instanceof Error ? err.message : String(err),
      );
    }

    // Drop broken unique+sparse indexes that collide on email:null
    try {
      await target.collection("users").dropIndex("email_1");
    } catch {
      /* ok */
    }
    try {
      await target.collection("users").dropIndex("phone_1");
    } catch {
      /* ok */
    }

    // Remove explicit nulls so partial unique indexes work
    await target.collection("users").updateMany(
      { $or: [{ email: null }, { email: "" }] },
      { $unset: { email: "" } },
    );
    await target.collection("users").updateMany(
      { $or: [{ phone: null }, { phone: "" }] },
      { $unset: { phone: "" } },
    );

    try {
      await target.collection("users").createIndexes([
        {
          key: { email: 1 },
          unique: true,
          name: "email_1",
          partialFilterExpression: { email: { $type: "string" } },
        },
        {
          key: { phone: 1 },
          name: "phone_1",
          sparse: true,
        },
      ]);
    } catch (err) {
      console.warn(
        "users indexes:",
        err instanceof Error ? err.message : String(err),
      );
    }

    try {
      await target
        .collection("conversations")
        .createIndex({ participants: 1, lastMessageAt: -1 });
      await target
        .collection("messages")
        .createIndex({ conversation: 1, createdAt: 1 });
      await target
        .collection("notifications")
        .createIndex({ user: 1, createdAt: -1 });
      await target.collection("sellerreviews").createIndexes([
        { key: { seller: 1, reviewer: 1 }, unique: true },
        { key: { seller: 1, status: 1, createdAt: -1 } },
      ]);
    } catch (err) {
      console.warn(
        "chat/notification/review indexes:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const reportPath = join(
    process.cwd(),
    "migration-reports",
    `migrate-${resolvedSourceName}-to-${resolvedTargetName}-${Date.now()}.json`,
  );
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        mode: DRY_RUN ? "dry-run" : "write",
        source: resolvedSourceName,
        target: resolvedTargetName,
        at: new Date().toISOString(),
        report,
      },
      null,
      2,
    ),
  );

  console.log("\n=== Summary ===");
  for (const [k, v] of Object.entries(report)) {
    console.log(
      `${k}: read~${v.read} written=${v.written} skipped=${v.skipped} errors=${v.errors.length}`,
    );
    v.errors.slice(0, 5).forEach((e) => console.log(`  ! ${e}`));
  }
  console.log(`Report: ${reportPath}`);
  if (DRY_RUN) {
    console.log("\nDry-run only. Re-run with --write to apply to newlistifysdb.");
  } else {
    console.log(
      "\nDone. Point API MONGODB_URI at newlistifysdb and spot-check listings/users/chat.",
    );
  }

  await sourceClient.close();
  await targetClient.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
