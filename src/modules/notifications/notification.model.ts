import mongoose, { Schema, type InferSchemaType } from "mongoose";

export const NOTIFICATION_TYPES = [
  "message",
  "listing",
  "offer",
  "promo",
  "system",
  "review",
] as const;

const notificationSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: NOTIFICATION_TYPES,
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, trim: true, maxlength: 1000 },
    href: { type: String, default: "" },
    image: { type: String, default: "" },
    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

notificationSchema.index({ user: 1, createdAt: -1 });

export type NotificationDocument = InferSchemaType<typeof notificationSchema> & {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
};

export const Notification = mongoose.model("Notification", notificationSchema);
