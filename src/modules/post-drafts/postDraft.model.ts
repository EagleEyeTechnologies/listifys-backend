import mongoose, { Schema, type InferSchemaType } from "mongoose";

/** Unpublished post-ad wizard state, synced so a draft started on one device opens on another. */
const postDraftSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /** Id the client generated for the draft; stable across devices. */
    clientId: { type: String, required: true, trim: true, maxlength: 64 },
    /** Which wizard wrote `form` — the web and mobile wizards use different field shapes. */
    source: { type: String, enum: ["web", "mobile"], required: true },
    step: { type: Number, default: 0 },
    form: { type: Schema.Types.Mixed, default: {} },
    savedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, minimize: false },
);

postDraftSchema.index({ user: 1, clientId: 1 }, { unique: true });
postDraftSchema.index({ user: 1, savedAt: -1 });

export type PostDraftDocument = InferSchemaType<typeof postDraftSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const PostDraft = mongoose.model("PostDraft", postDraftSchema);
