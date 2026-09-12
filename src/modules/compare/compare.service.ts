import mongoose from "mongoose";
import { z } from "zod";
import { User } from "../users/user.model.js";
import { Listing } from "../listings/listing.model.js";
import { AppError } from "../../utils/AppError.js";

const MAX_COMPARE = 3;

export const toggleCompareSchema = z.object({
  listingId: z.string().min(1),
});

function toPublicListing(doc: InstanceType<typeof Listing>) {
  const obj = doc.toObject();
  const coords = obj.coordinates?.coordinates;
  return {
    id: doc._id.toString(),
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
    images: obj.images,
    image: obj.images?.[0] || "",
    location: obj.location,
    city: obj.city,
    lat: coords?.[1],
    lng: coords?.[0],
    sellerId: obj.seller?.toString?.() || String(obj.seller),
    sellerName: obj.sellerName,
    sellerAvatar: obj.sellerAvatar,
    status: obj.status,
    featured: obj.featured,
    views: obj.views,
    extras: obj.extras || {},
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
}

async function getUserOrThrow(userId: string) {
  const user = await User.findById(userId);
  if (!user || !user.isActive) {
    throw new AppError(401, "User not found", "UNAUTHORIZED");
  }
  return user;
}

export async function listCompare(userId: string) {
  const user = await getUserOrThrow(userId);
  const ids = (user.compareListingIds || []).slice(0, MAX_COMPARE);
  const objectIds = ids.filter((id) => mongoose.isValidObjectId(id));
  const rows =
    objectIds.length > 0
      ? await Listing.find({
          _id: { $in: objectIds },
          status: { $ne: "removed" },
        })
      : [];
  const byId = new Map(rows.map((r) => [r._id.toString(), r]));
  const items = ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((doc) => toPublicListing(doc!));

  return { ids: [...ids], items, max: MAX_COMPARE };
}

export async function toggleCompare(userId: string, listingId: string) {
  const user = await getUserOrThrow(userId);
  const ids = [...(user.compareListingIds || [])];
  const idx = ids.indexOf(listingId);
  let added: boolean;

  if (idx >= 0) {
    ids.splice(idx, 1);
    added = false;
  } else {
    if (ids.length >= MAX_COMPARE) {
      throw new AppError(
        400,
        `Compare up to ${MAX_COMPARE} listings`,
        "COMPARE_LIMIT",
      );
    }
    if (mongoose.isValidObjectId(listingId)) {
      const listing = await Listing.findById(listingId);
      if (!listing || listing.status === "removed") {
        throw new AppError(404, "Listing not found", "NOT_FOUND");
      }
    }
    ids.push(listingId);
    added = true;
  }

  user.compareListingIds = ids;
  await user.save();
  return { added, ids, max: MAX_COMPARE };
}

export async function clearCompare(userId: string) {
  const user = await getUserOrThrow(userId);
  user.compareListingIds = [];
  await user.save();
  return { ids: [] as string[], max: MAX_COMPARE };
}
