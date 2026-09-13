import mongoose, { Schema, type InferSchemaType } from "mongoose";

const MAX_ADDRESSES_PER_USER = 10;

const addressSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    label: { type: String, trim: true, maxlength: 40, default: "Other" },
    receiverName: { type: String, trim: true, maxlength: 100, default: "" },
    phone: { type: String, trim: true, maxlength: 20, default: "" },
    houseNumber: { type: String, trim: true, maxlength: 80, default: "" },
    buildingName: { type: String, trim: true, maxlength: 120, default: "" },
    floor: { type: String, trim: true, maxlength: 40, default: "" },
    street: { type: String, trim: true, maxlength: 200, default: "" },
    landmark: { type: String, trim: true, maxlength: 200, default: "" },
    city: { type: String, trim: true, maxlength: 100, default: "" },
    state: { type: String, trim: true, maxlength: 100, default: "" },
    pincode: { type: String, trim: true, maxlength: 12, default: "" },
    formattedAddress: {
      type: String,
      trim: true,
      maxlength: 500,
      required: true,
    },
    placeId: { type: String, trim: true, default: "" },
    deliveryInstructions: {
      type: String,
      trim: true,
      maxlength: 400,
      default: "",
    },
    isDefault: { type: Boolean, default: false, index: true },
    coordinates: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], default: undefined },
    },
  },
  { timestamps: true },
);

addressSchema.index({ user: 1, isDefault: -1, updatedAt: -1 });

export type AddressDocument = InferSchemaType<typeof addressSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Address = mongoose.model("Address", addressSchema);
export { MAX_ADDRESSES_PER_USER };
