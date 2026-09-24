import mongoose, { Schema, type InferSchemaType } from "mongoose";

const sellerSubscriptionSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    paymentId: {
      type: Schema.Types.ObjectId,
      ref: "Payment",
      index: true,
    },
    planKey: { type: String, required: true, default: "monthly" },
    status: {
      type: String,
      enum: ["pending_payment", "trialing", "active", "cancelled", "expired", "refunded"],
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
    taxMinor: { type: Number, required: true, min: 0, default: 0 },
    totalMinor: { type: Number, required: true, min: 0 },
    trialDays: { type: Number, default: 7 },
    periodDays: { type: Number, default: 30 },
    trialEndsAt: Date,
    currentPeriodStart: Date,
    currentPeriodEnd: Date,
    cancelAtPeriodEnd: { type: Boolean, default: false },
    cancelledAt: Date,
    activatedAt: Date,
    provider: {
      type: String,
      enum: ["razorpay", "stripe", "mock", ""],
      default: "",
    },
    freeBoostsPerMonth: { type: Number, default: 3 },
    freeBoostsRemaining: { type: Number, default: 3 },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

sellerSubscriptionSchema.index({ userId: 1, status: 1 });
sellerSubscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });

export type SellerSubscriptionDocument = InferSchemaType<typeof sellerSubscriptionSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const SellerSubscription = mongoose.model("SellerSubscription", sellerSubscriptionSchema);
