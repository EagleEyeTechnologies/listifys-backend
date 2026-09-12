import mongoose, { Schema, type InferSchemaType } from "mongoose";

const eventBookingSchema = new Schema(
  {
    listingId: {
      type: Schema.Types.ObjectId,
      ref: "Listing",
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sellerId: {
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
    ticketQuantity: { type: Number, required: true, min: 1, max: 50 },
    unitPrice: { type: Number, required: true, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    currencySymbol: { type: String, default: "$" },
    currency: { type: String, default: "USD", uppercase: true },
    countryCode: {
      type: String,
      enum: ["US", "CA", "IN"],
      default: "US",
      uppercase: true,
      index: true,
    },
    attendeeName: { type: String, trim: true, default: "" },
    attendeePhone: { type: String, trim: true, default: "" },
    notes: { type: String, trim: true, default: "" },
    eventTitle: { type: String, default: "" },
    status: {
      type: String,
      enum: [
        "pending_payment",
        "confirmed",
        "cancelled",
        "refunded",
        "withdraw_requested",
      ],
      default: "pending_payment",
      index: true,
    },
    isFree: { type: Boolean, default: false },
    confirmedAt: Date,
    cancelledAt: Date,
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

eventBookingSchema.index({ listingId: 1, userId: 1, createdAt: -1 });

export type EventBookingDocument = InferSchemaType<typeof eventBookingSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const EventBooking = mongoose.model("EventBooking", eventBookingSchema);
