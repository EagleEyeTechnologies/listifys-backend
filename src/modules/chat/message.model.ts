import mongoose, { Schema, type InferSchemaType } from "mongoose";

const messageSchema = new Schema(
  {
    conversation: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },
    sender: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    text: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },
    kind: {
      type: String,
      enum: ["text", "system"],
      default: "text",
    },
    readBy: {
      type: [Schema.Types.ObjectId],
      ref: "User",
      default: [],
    },
    /** Recipient received the message (WhatsApp double-grey). */
    deliveredTo: {
      type: [Schema.Types.ObjectId],
      ref: "User",
      default: [],
    },
    /** Listing context when this message was sent (multi-listing threads). */
    listingId: {
      type: Schema.Types.ObjectId,
      ref: "Listing",
      default: null,
    },
    listingTitle: { type: String, default: "" },
    listingImage: { type: String, default: "" },
    listingPrice: { type: Number, default: null },
    listingHref: { type: String, default: "" },
    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

messageSchema.index({ conversation: 1, createdAt: 1 });

export type MessageDocument = InferSchemaType<typeof messageSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Message = mongoose.model("Message", messageSchema);
