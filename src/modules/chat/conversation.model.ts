import mongoose, { Schema, type InferSchemaType } from "mongoose";

const conversationSchema = new Schema(
  {
    participants: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
    ],
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

export type ConversationDocument = InferSchemaType<typeof conversationSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Conversation = mongoose.model("Conversation", conversationSchema);
