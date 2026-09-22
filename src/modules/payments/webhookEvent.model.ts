import mongoose, { Schema, type InferSchemaType } from "mongoose";

const webhookEventSchema = new Schema(
  {
    provider: {
      type: String,
      enum: ["razorpay", "stripe"],
      required: true,
      index: true,
    },
    providerEventId: { type: String, required: true },
    eventType: { type: String, default: "" },
    payload: { type: Schema.Types.Mixed, default: {} },
    processed: { type: Boolean, default: false, index: true },
    processedAt: Date,
    error: { type: String, default: "" },
  },
  { timestamps: true },
);

webhookEventSchema.index({ provider: 1, providerEventId: 1 }, { unique: true });

export type WebhookEventDocument = InferSchemaType<typeof webhookEventSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const WebhookEvent = mongoose.model("WebhookEvent", webhookEventSchema);
