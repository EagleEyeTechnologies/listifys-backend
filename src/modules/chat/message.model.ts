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
      trim: true,
      maxlength: 5000,
      default: "",
    },
    attachments: {
      type: [
        new Schema(
          {
            url: { type: String, required: true, trim: true },
            name: { type: String, trim: true, default: "" },
            mime: { type: String, trim: true, default: "" },
          },
          { _id: false },
        ),
      ],
      default: [],
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
    /** Snapshot of the quoted message; text is cleared if the original is deleted for everyone. */
    replyTo: {
      type: new Schema(
        {
          messageId: { type: Schema.Types.ObjectId, ref: "Message", required: true },
          sender: { type: Schema.Types.ObjectId, ref: "User", required: true },
          text: { type: String, default: "" },
          hasImage: { type: Boolean, default: false },
          deleted: { type: Boolean, default: false },
        },
        { _id: false },
      ),
      default: null,
    },
    /** "Delete for me": hidden only for these users. */
    hiddenFor: {
      type: [Schema.Types.ObjectId],
      ref: "User",
      default: [],
    },
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
