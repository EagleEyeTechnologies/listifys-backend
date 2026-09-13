import mongoose, { Schema, type InferSchemaType } from "mongoose";

const notificationCampaignSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, trim: true, maxlength: 1000 },
    audience: {
      type: String,
      enum: ["all", "premium", "IN", "US", "CA"],
      default: "all",
      index: true,
    },
    channel: {
      type: String,
      enum: ["push_inapp", "push", "inapp"],
      default: "push_inapp",
    },
    status: {
      type: String,
      enum: ["draft", "scheduled", "sent"],
      default: "draft",
      index: true,
    },
    scheduledAt: Date,
    sentAt: Date,
    recipientCount: { type: Number, default: 0 },
    openCount: { type: Number, default: 0 },
    createdByEmail: { type: String, default: "" },
    createdByName: { type: String, default: "" },
  },
  { timestamps: true },
);

export type NotificationCampaignDocument = InferSchemaType<
  typeof notificationCampaignSchema
> & {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
};

export const NotificationCampaign = mongoose.model(
  "NotificationCampaign",
  notificationCampaignSchema,
);
