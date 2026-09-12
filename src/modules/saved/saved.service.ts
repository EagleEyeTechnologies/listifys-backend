import mongoose from "mongoose";
import { z } from "zod";
import { User } from "../users/user.model.js";
import { Listing } from "../listings/listing.model.js";
import { AppError } from "../../utils/AppError.js";

export const toggleSavedSchema = z.object({
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

export async function listSaved(userId: string) {
  const user = await getUserOrThrow(userId);
  const ids = user.savedListingIds || [];
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

  return { ids: [...ids], items };
}

export async function toggleSaved(userId: string, listingId: string) {
  const user = await getUserOrThrow(userId);
  const ids = [...(user.savedListingIds || [])];
  const idx = ids.indexOf(listingId);
  let saved: boolean;
  if (idx >= 0) {
    ids.splice(idx, 1);
    saved = false;
  } else {
    // Prefer validating ObjectId listings; still allow string ids for client mocks during hybrid
    if (mongoose.isValidObjectId(listingId)) {
      const listing = await Listing.findById(listingId);
      if (!listing || listing.status === "removed") {
        throw new AppError(404, "Listing not found", "NOT_FOUND");
      }
    }
    ids.unshift(listingId);
    saved = true;
  }
  user.savedListingIds = ids;
  await user.save();
  return { saved, ids };
}

export async function clearSaved(userId: string) {
  const user = await getUserOrThrow(userId);
  user.savedListingIds = [];
  await user.save();
  return { ids: [] as string[] };
}
