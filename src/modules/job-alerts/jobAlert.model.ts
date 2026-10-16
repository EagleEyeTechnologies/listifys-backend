import mongoose, { Schema, type InferSchemaType } from "mongoose";

const jobAlertSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    listingId: { type: String, default: "", trim: true },
    keyword: { type: String, required: true, trim: true, maxlength: 120 },
    location: { type: String, default: "", trim: true, maxlength: 120 },
    jobType: { type: String, default: "", trim: true, maxlength: 80 },
    experience: { type: String, default: "", trim: true, maxlength: 80 },
  },
  { timestamps: true },
);

jobAlertSchema.index({ user: 1, listingId: 1 });

export type JobAlertDocument = InferSchemaType<typeof jobAlertSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const JobAlert = mongoose.model("JobAlert", jobAlertSchema);
