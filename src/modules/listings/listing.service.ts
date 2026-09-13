import { z } from "zod";
import mongoose from "mongoose";
import { Listing } from "./listing.model.js";
import { User } from "../users/user.model.js";
import { CATEGORY_SLUGS } from "../../types/domain.js";
import { AppError } from "../../utils/AppError.js";
import { distanceMiles } from "../../utils/geo.js";
import { indexListing, removeListingFromIndex } from "../search/search.service.js";
import { enqueueListingSideEffect } from "../../queues/listingQueue.js";
import { isMongoObjectId, listingSlugFrom } from "../../utils/slug.js";
import { absolutizeMediaUrl } from "../../utils/mediaUrl.js";

export const createListingSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(10).max(10000),
  category: z.enum(CATEGORY_SLUGS),
  subcategory: z.string().optional(),
  subSubcategory: z.string().optional(),
  intent: z.enum(["sale", "wanted", "free"]).optional(),
  price: z.number().min(0),
  currency: z.string().optional(),
  condition: z.string().optional(),
    images: z.array(z.string().min(1)).max(20).optional(),
  location: z.string().min(2),
  city: z.string().min(2),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  featured: z.boolean().optional(),
  extras: z.record(z.unknown()).optional(),
});

export const updateListingSchema = createListingSchema.partial().extend({
  status: z.enum(["active", "sold", "paused", "expired"]).optional(),
});

export const listQuerySchema = z.object({
  category: z.enum(CATEGORY_SLUGS).optional(),
  intent: z.enum(["sale", "wanted", "free"]).optional(),
  type: z.string().optional(),
  city: z.string().optional(),
  q: z.string().optional(),
  status: z
    .enum(["active", "sold", "paused", "expired", "removed"])
    .optional()
    .default("active"),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  radiusMiles: z.coerce.number().min(1).max(500).optional(),
  sort: z
    .enum(["latest", "price-asc", "price-desc", "nearest"])
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
  void doc.save().catch(() => undefined);
  return generated;
}

function toPublic(doc: InstanceType<typeof Listing>) {
  const obj = doc.toObject();
  const coords = obj.coordinates?.coordinates;
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

  const listing = await Listing.create({
    ...input,
    currency: input.currency || currencyFor(countryCode),
    countryCode,
    images: input.images || [],
    seller: seller._id,
    sellerName: seller.name || "",
    sellerAvatar: seller.avatar || "",
    intent: input.intent || "sale",
    extras: input.extras || {},
    coordinates:
      input.lat !== undefined && input.lng !== undefined
        ? { type: "Point", coordinates: [input.lng, input.lat] }
        : undefined,
  });

  listing.slug = listingPublicSlug(listing);
  await listing.save();
  await indexListing(listing);
  await enqueueListingSideEffect("created", listing._id.toString());
  return toPublic(listing);
}

export async function getListingById(idOrSlug: string) {
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
  listing.views = (listing.views || 0) + 1;
  if (!listing.slug) listing.slug = listingSlugFrom(listing.title, listing._id.toString());

  // Prefer live seller avatar/name (denormalized fields can be stale/empty)
  const seller = await User.findById(listing.seller)
    .select("avatar name")
    .lean();
  if (seller) {
    if (seller.avatar) {
      listing.sellerAvatar = seller.avatar;
    }
    if (seller.name) {
      listing.sellerName = seller.name;
    }
  }

  await listing.save();
  return toPublic(listing);
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

  Object.assign(listing, {
    ...input,
    extras: input.extras !== undefined ? input.extras : listing.extras,
  });

  if (input.lat !== undefined && input.lng !== undefined) {
    listing.coordinates = {
      type: "Point",
      coordinates: [input.lng, input.lat],
    };
  }

  await listing.save();
  await indexListing(listing);
  await enqueueListingSideEffect("updated", listing._id.toString());
  return toPublic(listing);
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
  return { id };
}

export async function listMyListings(sellerId: string) {
  const rows = await Listing.find({
    seller: sellerId,
    status: { $ne: "removed" },
  })
    .sort({ createdAt: -1 })
    .limit(200);
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
) {
  const filter: Record<string, unknown> = {
    status: query.status || "active",
  };
  // Seller public profile: show all markets for that seller (don't hide by browse country)
  if (query.sellerId && mongoose.isValidObjectId(query.sellerId)) {
    filter.seller = query.sellerId;
  } else {
    filter.countryCode = countryCode;
  }
  if (query.category) filter.category = query.category;
  if (query.intent) filter.intent = query.intent;
  if (query.city) filter.city = new RegExp(`^${query.city}$`, "i");
  if (query.q) filter.$text = { $search: query.q };

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
  if (query.sort === "price-asc") sort = { price: 1 };
  if (query.sort === "price-desc") sort = { price: -1 };

  const useGeo =
    query.lat !== undefined &&
    query.lng !== undefined &&
    (query.radiusMiles !== undefined || query.sort === "nearest");

  if (useGeo && query.radiusMiles) {
    filter.coordinates = {
      $geoWithin: {
        $centerSphere: [
          [query.lng, query.lat],
          query.radiusMiles / 3958.8,
        ],
      },
    };
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
        distanceMiles: Number(
          distanceMiles(query.lat!, query.lng!, item.lat, item.lng).toFixed(1),
        ),
      };
    });
    if (query.sort === "nearest") {
      items = items.sort(
        (a, b) => (a.distanceMiles ?? 1e9) - (b.distanceMiles ?? 1e9),
      );
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
