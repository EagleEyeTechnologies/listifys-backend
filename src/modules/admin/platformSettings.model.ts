import mongoose, { Schema, type InferSchemaType } from "mongoose";

const platformSettingsSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: "default" },
    enabledMarkets: {
      type: [{ type: String, enum: ["IN", "US", "CA"] }],
      default: ["IN", "US", "CA"],
    },
  },
  { timestamps: true },
);

export type PlatformSettingsDocument = InferSchemaType<typeof platformSettingsSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const PlatformSettings = mongoose.model("PlatformSettings", platformSettingsSchema);
