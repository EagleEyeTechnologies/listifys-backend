import mongoose, { Schema, type InferSchemaType } from "mongoose";

const sellerReviewSchema = new Schema(
  {
    seller: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    reviewer: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    listing: {
      type: Schema.Types.ObjectId,
      ref: "Listing",
      default: null,
    },
    listingCategory: { type: String, trim: true, default: "" },
    rating: { type: Number, required: true, min: 1, max: 5 },
    title: { type: String, trim: true, maxlength: 100, default: "" },
    comment: {
      type: String,
      required: true,
      trim: true,
      minlength: 10,
      maxlength: 1000,
    },
    status: {
      type: String,
      enum: ["published", "hidden", "flagged"],
      default: "published",
      index: true,
    },
  },
  { timestamps: true },
);

sellerReviewSchema.index({ seller: 1, reviewer: 1 }, { unique: true });
sellerReviewSchema.index({ seller: 1, status: 1, createdAt: -1 });

export type SellerReviewDocument = InferSchemaType<typeof sellerReviewSchema> & {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
};

export const SellerReview = mongoose.model("SellerReview", sellerReviewSchema);
