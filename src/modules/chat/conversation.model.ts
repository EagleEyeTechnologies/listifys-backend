import mongoose, { Schema, type InferSchemaType } from "mongoose";

const conversationSchema = new Schema(
  {
    /**
     * Stable identity for a 1:1 chat: sorted `${userA}:${userB}`.
     * One conversation per user pair — listing is context only.
     */
    participantKey: { type: String, trim: true, index: true },
    participants: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
    ],
    /** Latest listing context (updated when messaging about a different listing). */
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", default: null },
    listingTitle: { type: String, default: "" },
    listingImage: { type: String, default: "" },
    listingPrice: { type: Number, default: 0 },
    listingHref: { type: String, default: "" },
    lastMessageText: { type: String, default: "" },
    lastMessageAt: { type: Date, default: null, index: true },
    unreadBy: {
      type: Map,
      of: Number,
      default: {},
    },
  },
  { timestamps: true },
);

conversationSchema.index({ participants: 1, lastMessageAt: -1 });
conversationSchema.index(
  { participantKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      participantKey: { $type: "string", $gt: "" },
    },
  },
);

export type ConversationDocument = InferSchemaType<typeof conversationSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Conversation = mongoose.model("Conversation", conversationSchema);

/** Sorted pair key so (A,B) and (B,A) map to the same conversation. */
export function makeParticipantKey(userA: string, userB: string): string {
  return [String(userA), String(userB)].sort().join(":");
}
