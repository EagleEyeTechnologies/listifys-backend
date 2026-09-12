import mongoose, { Schema, type InferSchemaType } from "mongoose";

const boostCampaignSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    listingId: {
      type: Schema.Types.ObjectId,
      ref: "Listing",
      required: true,
      index: true,
    },
    listingTitle: { type: String, default: "" },
    listingImage: { type: String, default: "" },
    paymentId: {
      type: Schema.Types.ObjectId,
      ref: "Payment",
      index: true,
    },
    planKey: { type: String, required: true },
    planDays: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: [
        "pending_payment",
        "active",
        "expired",
        "cancelled",
        "refunded",
      ],
      default: "pending_payment",
      index: true,
    },
    countryCode: {
      type: String,
      enum: ["US", "CA", "IN"],
      required: true,
    },
    currency: { type: String, required: true, uppercase: true },
    amountMinor: { type: Number, required: true, min: 0 },
    taxMinor: { type: Number, required: true, min: 0 },
    totalMinor: { type: Number, required: true, min: 0 },
    startAt: Date,
    endAt: Date,
    activatedAt: Date,
    expiredAt: Date,
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

boostCampaignSchema.index({ listingId: 1, status: 1 });
boostCampaignSchema.index({ status: 1, endAt: 1 });

export type BoostCampaignDocument = InferSchemaType<
  typeof boostCampaignSchema
> & {
  _id: mongoose.Types.ObjectId;
};

export const BoostCampaign = mongoose.model(
  "BoostCampaign",
  boostCampaignSchema,
);
