import mongoose, { Schema, type InferSchemaType } from "mongoose";

const paymentSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    purpose: {
      type: String,
      enum: ["boost", "premium_subscription", "event_ticket"],
      default: "boost",
      index: true,
    },
    campaignId: {
      type: Schema.Types.ObjectId,
      ref: "BoostCampaign",
      index: true,
    },
    subscriptionId: {
      type: Schema.Types.ObjectId,
      ref: "SellerSubscription",
      index: true,
    },
    eventBookingId: {
      type: Schema.Types.ObjectId,
      ref: "EventBooking",
      index: true,
    },
    provider: {
      type: String,
      enum: ["razorpay", "stripe", "mock"],
      required: true,
    },
    status: {
      type: String,
      enum: [
        "created",
        "pending",
        "succeeded",
        "failed",
        "cancelled",
        "refunded",
      ],
      default: "created",
      index: true,
    },
    currency: { type: String, required: true, uppercase: true },
    countryCode: {
      type: String,
      enum: ["US", "CA", "IN"],
      required: true,
      index: true,
    },
    amountMinor: { type: Number, required: true, min: 0 },
    taxMinor: { type: Number, required: true, min: 0, default: 0 },
    totalMinor: { type: Number, required: true, min: 0 },
    planKey: { type: String, required: true },
    planDays: { type: Number, required: true, min: 1 },
    listingId: {
      type: Schema.Types.ObjectId,
      ref: "Listing",
      index: true,
      default: null,
    },
    providerOrderId: { type: String, default: "", index: true },
    providerPaymentId: { type: String, default: "", index: true },
    providerClientSecret: { type: String, default: "" },
    metadata: { type: Schema.Types.Mixed, default: {} },
    succeededAt: Date,
    refundedAt: Date,
  },
  { timestamps: true },
);

paymentSchema.index({ provider: 1, providerOrderId: 1 });
paymentSchema.index({ provider: 1, providerPaymentId: 1 });

export type PaymentDocument = InferSchemaType<typeof paymentSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Payment = mongoose.model("Payment", paymentSchema);
