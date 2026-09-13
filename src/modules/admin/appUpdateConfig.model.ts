import mongoose, { Schema, type InferSchemaType } from "mongoose";

const appUpdateConfigSchema = new Schema(
  {
    platform: {
      type: String,
      enum: ["android", "ios", "both"],
      required: true,
      index: true,
    },
    versionName: { type: String, required: true, trim: true },
    versionCode: { type: String, required: true, trim: true },
    buildNumber: { type: String, default: "", trim: true },
    minSupportedVersion: { type: String, default: "", trim: true },
    forceUpdate: { type: Boolean, default: false },
    storeUrl: { type: String, default: "", trim: true },
    releaseNotes: { type: String, default: "", maxlength: 5000 },
    status: {
      type: String,
      enum: ["draft", "active", "deprecated"],
      default: "draft",
      index: true,
    },
    publishedAt: Date,
    activatedByEmail: { type: String, default: "" },
  },
  { timestamps: true },
);

export type AppUpdateConfigDocument = InferSchemaType<
  typeof appUpdateConfigSchema
> & {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
};

export const AppUpdateConfig = mongoose.model(
  "AppUpdateConfig",
  appUpdateConfigSchema,
);
