import mongoose, { Schema, type InferSchemaType } from "mongoose";

const moderationReportSchema = new Schema(
  {
    type: {
      type: String,
      enum: ["listing", "user", "image", "chat", "review"],
      required: true,
      index: true,
    },
    subject: { type: String, required: true, trim: true },
    subjectId: { type: Schema.Types.ObjectId, index: true },
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      index: true,
    },
    reviewId: { type: Schema.Types.ObjectId, ref: "SellerReview", index: true },
    imageUrl: { type: String, default: "" },
    source: {
      type: String,
      enum: ["user_report", "admin_flag", "system", "sync"],
      default: "user_report",
      index: true,
    },
    reporterId: { type: Schema.Types.ObjectId, ref: "User" },
    reporterName: { type: String, default: "" },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    status: {
      type: String,
      enum: ["open", "reviewing", "resolved", "dismissed"],
      default: "open",
      index: true,
    },
    priority: {
      type: String,
      enum: ["high", "medium", "low"],
      default: "medium",
      index: true,
    },
    resolvedBy: { type: String, default: "" },
    resolvedAt: Date,
    notes: { type: String, default: "", maxlength: 2000 },
  },
  { timestamps: true },
);

moderationReportSchema.index({ status: 1, createdAt: -1 });

export type ModerationReportDocument = InferSchemaType<
  typeof moderationReportSchema
> & {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
};

export const ModerationReport = mongoose.model(
  "ModerationReport",
  moderationReportSchema,
);
