import mongoose, { Schema, type InferSchemaType } from "mongoose";

const listingOfferSchema = new Schema(
  {
    listing: {
      type: Schema.Types.ObjectId,
      ref: "Listing",
      required: true,
      index: true,
    },
    listingTitle: { type: String, default: "" },
    listingImage: { type: String, default: "" },
    listingHref: { type: String, default: "" },
    buyer: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    seller: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    amount: { type: Number, required: true, min: 0 },
    listPrice: { type: Number, default: 0 },
    currency: { type: String, default: "INR" },
    message: { type: String, default: "", maxlength: 1000 },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "countered"],
      default: "pending",
      index: true,
    },
    counterAmount: { type: Number },
  },
  { timestamps: true },
);

listingOfferSchema.index({ seller: 1, createdAt: -1 });
listingOfferSchema.index({ buyer: 1, createdAt: -1 });

export type ListingOfferDocument = InferSchemaType<typeof listingOfferSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const ListingOffer = mongoose.model("ListingOffer", listingOfferSchema);
