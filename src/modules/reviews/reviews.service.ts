import mongoose from "mongoose";
import { z } from "zod";
import { SellerReview } from "./sellerReview.model.js";
import { User } from "../users/user.model.js";
import { Listing } from "../listings/listing.model.js";
import { AppError } from "../../utils/AppError.js";
import { absolutizeMediaUrl } from "../../utils/mediaUrl.js";

export async function getSellerReviewStats(sellerId: string) {
  if (!mongoose.isValidObjectId(sellerId)) {
    return { averageRating: 0, totalReviews: 0 };
  }
  const result = await SellerReview.aggregate([
    {
      $match: {
        seller: new mongoose.Types.ObjectId(sellerId),
        status: "published",
      },
    },
    {
      $group: {
        _id: "$seller",
        averageRating: { $avg: "$rating" },
        totalReviews: { $sum: 1 },
      },
    },
  ]);
  if (!result.length) return { averageRating: 0, totalReviews: 0 };
  return {
    averageRating: Math.round(Number(result[0].averageRating) * 10) / 10,
    totalReviews: Number(result[0].totalReviews) || 0,
  };
}

export function serializeReview(
  doc: InstanceType<typeof SellerReview>,
  reviewer?: { name?: string; avatar?: string } | null,
) {
  return {
    id: doc._id.toString(),
    sellerId: doc.seller.toString(),
    reviewerId: doc.reviewer.toString(),
    reviewerName: reviewer?.name || "Buyer",
    reviewerAvatar: absolutizeMediaUrl(reviewer?.avatar),
    listingId: doc.listing ? doc.listing.toString() : null,
    listingCategory: doc.listingCategory || "",
    rating: doc.rating,
    title: doc.title || "",
    comment: doc.comment,
    status: doc.status,
    createdAt:
      (
        doc as InstanceType<typeof SellerReview> & { createdAt?: Date }
      ).createdAt?.toISOString?.() || new Date().toISOString(),
  };
}

export async function listSellerReviews(sellerId: string, limit = 20) {
  if (!mongoose.isValidObjectId(sellerId)) {
    throw new AppError(400, "Invalid seller id", "VALIDATION_ERROR");
  }
  const rows = await SellerReview.find({
    seller: sellerId,
    status: "published",
  })
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 50));

  const reviewerIds = [...new Set(rows.map((r) => r.reviewer.toString()))];
  const reviewers = await User.find({ _id: { $in: reviewerIds } }).select("name avatar");
  const byId = new Map(reviewers.map((u) => [u._id.toString(), u]));

  return {
    stats: await getSellerReviewStats(sellerId),
    items: rows.map((r) => serializeReview(r, byId.get(r.reviewer.toString()))),
  };
}

export const createReviewSchema = z.object({
  sellerId: z.string().min(1),
  listingId: z.string().optional(),
  rating: z.coerce.number().int().min(1).max(5),
  title: z.string().max(100).optional(),
  comment: z.string().min(10).max(1000),
});

export async function createSellerReview(
  reviewerId: string,
  input: z.infer<typeof createReviewSchema>,
) {
  if (!mongoose.isValidObjectId(input.sellerId)) {
    throw new AppError(400, "Invalid seller id", "VALIDATION_ERROR");
  }
  if (input.sellerId === reviewerId) {
    throw new AppError(400, "You cannot review yourself", "FORBIDDEN");
  }

  const seller = await User.findById(input.sellerId);
  if (!seller || !seller.isActive) {
    throw new AppError(404, "Seller not found", "NOT_FOUND");
  }

  let listingCategory = "";
  if (input.listingId) {
    if (!mongoose.isValidObjectId(input.listingId)) {
      throw new AppError(400, "Invalid listing id", "VALIDATION_ERROR");
    }
    const listing = await Listing.findById(input.listingId).select("seller category");
    if (!listing) throw new AppError(404, "Listing not found", "NOT_FOUND");
    if (listing.seller.toString() !== input.sellerId) {
      throw new AppError(400, "Listing does not belong to this seller", "VALIDATION_ERROR");
    }
    listingCategory = listing.category;
  }

  try {
    const doc = await SellerReview.create({
      seller: input.sellerId,
      reviewer: reviewerId,
      listing: input.listingId || null,
      listingCategory: listingCategory || "",
      rating: input.rating,
      title: input.title?.trim() || "",
      comment: input.comment.trim(),
      status: "published",
    });
    const reviewer = await User.findById(reviewerId).select("name avatar");
    return {
      review: serializeReview(doc, reviewer),
      stats: await getSellerReviewStats(input.sellerId),
    };
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      throw new AppError(409, "You already reviewed this seller", "ALREADY_REVIEWED");
    }
    throw err;
  }
}

export const updateReviewSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5).optional(),
  title: z.string().max(100).optional(),
  comment: z.string().min(10).max(1000).optional(),
});

export async function updateOwnSellerReview(
  reviewerId: string,
  reviewId: string,
  input: z.infer<typeof updateReviewSchema>,
) {
  if (!mongoose.isValidObjectId(reviewId)) {
    throw new AppError(400, "Invalid review id", "VALIDATION_ERROR");
  }
  const doc = await SellerReview.findById(reviewId);
  if (!doc) throw new AppError(404, "Review not found", "NOT_FOUND");
  if (doc.reviewer.toString() !== reviewerId) {
    throw new AppError(403, "You can only edit your own review", "FORBIDDEN");
  }
  if (input.rating != null) doc.rating = input.rating;
  if (input.title !== undefined) doc.title = input.title.trim();
  if (input.comment !== undefined) doc.comment = input.comment.trim();
  await doc.save();
  const reviewer = await User.findById(reviewerId).select("name avatar");
  return {
    review: serializeReview(doc, reviewer),
    stats: await getSellerReviewStats(doc.seller.toString()),
  };
}

export async function deleteOwnSellerReview(
  reviewerId: string,
  reviewId: string,
) {
  if (!mongoose.isValidObjectId(reviewId)) {
    throw new AppError(400, "Invalid review id", "VALIDATION_ERROR");
  }
  const doc = await SellerReview.findById(reviewId);
  if (!doc) throw new AppError(404, "Review not found", "NOT_FOUND");
  if (doc.reviewer.toString() !== reviewerId) {
    throw new AppError(403, "You can only delete your own review", "FORBIDDEN");
  }
  const sellerId = doc.seller.toString();
  await doc.deleteOne();
  return { ok: true, stats: await getSellerReviewStats(sellerId) };
}
