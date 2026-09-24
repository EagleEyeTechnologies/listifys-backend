import mongoose, { Schema, type InferSchemaType } from "mongoose";

const adminAccountSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["super", "moderator", "support"],
      default: "moderator",
    },
    isActive: { type: Boolean, default: true, index: true },
    lastLoginAt: Date,
    addedByEmail: { type: String, default: "" },
  },
  { timestamps: true },
);

export type AdminAccountDocument = InferSchemaType<typeof adminAccountSchema> & {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
};

export const AdminAccount = mongoose.model("AdminAccount", adminAccountSchema);
