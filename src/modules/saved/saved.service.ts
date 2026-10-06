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

function savedTimes(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value) continue;
    const date = new Date(String(value));
    if (!Number.isNaN(date.getTime())) out[key] = date.toISOString();
  }
  return out;
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
          $or: [{ status: { $nin: ["removed", "paused"] } }, { status: "paused", seller: userId }],
        })
      : [];
  const byId = new Map(rows.map((r) => [r._id.toString(), r]));
  const savedAt = savedTimes(user.get("savedListingAt"));
  const items = ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((doc) => toPublicListing(doc!));

  return { ids: [...ids], savedAt, items };
}

export async function toggleSaved(userId: string, listingId: string) {
  const user = await getUserOrThrow(userId);
  const ids = [...(user.savedListingIds || [])];
  const times = savedTimes(user.get("savedListingAt"));
  const idx = ids.indexOf(listingId);
  let saved: boolean;
  if (idx >= 0) {
    ids.splice(idx, 1);
    delete times[listingId];
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
    times[listingId] = new Date().toISOString();
    saved = true;
  }
  user.savedListingIds = ids;
  user.set("savedListingAt", times);
  user.markModified("savedListingAt");
  await user.save();
  return { saved, ids, savedAt: times };
}

export async function clearSaved(userId: string) {
  const user = await getUserOrThrow(userId);
  user.savedListingIds = [];
  user.set("savedListingAt", {});
  user.markModified("savedListingAt");
  await user.save();
  return { ids: [] as string[], savedAt: {} as Record<string, string> };
}
