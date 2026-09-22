import mongoose, { Schema, type InferSchemaType } from "mongoose";

const adminActivitySchema = new Schema(
  {
    adminId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    adminEmail: { type: String, required: true, index: true },
    adminName: { type: String, default: "" },
    action: { type: String, required: true, trim: true },
    target: { type: String, default: "", trim: true },
    section: { type: String, default: "General", index: true },
    ip: { type: String, default: "" },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

adminActivitySchema.index({ createdAt: -1 });

export type AdminActivityDocument = InferSchemaType<typeof adminActivitySchema> & {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
};

export const AdminActivity = mongoose.model("AdminActivity", adminActivitySchema);
