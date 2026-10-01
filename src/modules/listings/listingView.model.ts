import mongoose, { Schema } from "mongoose";

/** One row per person per listing. A repeat visit does not add another view. */
const listingViewSchema = new Schema(
  {
    listing: { type: Schema.Types.ObjectId, ref: "Listing", required: true },
    viewerKey: { type: String, required: true, maxlength: 120 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

listingViewSchema.index({ listing: 1, viewerKey: 1 }, { unique: true });

export const ListingView =
  mongoose.models.ListingView || mongoose.model("ListingView", listingViewSchema);
