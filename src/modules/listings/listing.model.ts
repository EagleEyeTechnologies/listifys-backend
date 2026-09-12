import mongoose, { Schema, type InferSchemaType } from "mongoose";
import { CATEGORY_SLUGS } from "../../types/domain.js";

const pointSchema = new Schema(
  {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: {
      type: [Number],
      validate: {
        validator: (v: number[]) => Array.isArray(v) && v.length === 2,
        message: "coordinates must be [lng, lat]",
      },
    },
  },
  { _id: false },
);

const listingSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    /** SEO URL segment — unique when set (title-slug + id suffix). */
    slug: { type: String, trim: true, lowercase: true, sparse: true, unique: true },
    description: { type: String, required: true, trim: true, maxlength: 10000 },
    category: { type: String, enum: CATEGORY_SLUGS, required: true, index: true },
    subcategory: { type: String, trim: true, default: "" },
    subSubcategory: { type: String, trim: true, default: "" },
    intent: {
      type: String,
      enum: ["sale", "wanted", "free"],
      default: "sale",
      index: true,
    },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "INR" },
    countryCode: {
      type: String,
      enum: ["US", "CA", "IN"],
      required: true,
      index: true,
    },
    condition: { type: String, trim: true, default: "" },
    images: { type: [String], default: [] },
    location: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true, index: true },
    coordinates: { type: pointSchema },
    seller: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sellerName: { type: String, default: "" },
    sellerAvatar: { type: String, default: "" },
    status: {
      type: String,
      enum: ["active", "sold", "paused", "expired", "removed"],
      default: "active",
      index: true,
    },
    featured: { type: Boolean, default: false },
    views: { type: Number, default: 0 },
    extras: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

listingSchema.index({ countryCode: 1, status: 1, category: 1 });
listingSchema.index({ seller: 1, status: 1 });
listingSchema.index({ coordinates: "2dsphere" });
listingSchema.index({ title: "text", description: "text" });

export type ListingDocument = InferSchemaType<typeof listingSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Listing = mongoose.model("Listing", listingSchema);
