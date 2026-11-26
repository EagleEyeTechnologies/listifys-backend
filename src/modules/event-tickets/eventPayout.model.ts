import mongoose, { Schema, type InferSchemaType } from "mongoose";

const eventOrganizerPayoutSchema = new Schema(
  {
    organizerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    listingId: {
      type: Schema.Types.ObjectId,
      ref: "Listing",
      required: true,
      unique: true,
      index: true,
    },
    eventTitle: { type: String, default: "" },
    currency: { type: String, required: true, uppercase: true },
    countryCode: {
      type: String,
      enum: ["US", "CA", "IN"],
      required: true,
      index: true,
    },
    /** Ticket sales that succeeded (minor units). */
    grossMinor: { type: Number, required: true, min: 0, default: 0 },
    /** Amount refunded to attendees (minor units). */
    refundedMinor: { type: Number, required: true, min: 0, default: 0 },
    /** Platform fee on net sales (minor units). */
    feeMinor: { type: Number, required: true, min: 0, default: 0 },
    /** Organizer share = gross − refunded − fee. */
    netMinor: { type: Number, required: true, min: 0, default: 0 },
    feePercent: { type: Number, required: true, min: 0, max: 100, default: 10 },
    status: {
      type: String,
      enum: ["pending", "payable", "processing", "paid", "failed"],
      default: "pending",
      index: true,
    },
    eventEndsAt: { type: Date, default: null, index: true },
    paidAt: { type: Date, default: null },
    reference: { type: String, default: "" },
    notes: { type: String, default: "" },
    paidByAdminId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

eventOrganizerPayoutSchema.index({ status: 1, updatedAt: -1 });
eventOrganizerPayoutSchema.index({ organizerId: 1, status: 1 });

export type EventOrganizerPayoutDocument = InferSchemaType<typeof eventOrganizerPayoutSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const EventOrganizerPayout = mongoose.model(
  "EventOrganizerPayout",
  eventOrganizerPayoutSchema,
);
