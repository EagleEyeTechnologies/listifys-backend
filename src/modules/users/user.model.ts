import mongoose, { Schema, type InferSchemaType } from "mongoose";
import type { CountryCode } from "../../types/domain.js";

const userSchema = new Schema(
  {
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    phoneCode: { type: String, trim: true },
    name: { type: String, trim: true, default: "" },
    /** Public profile URL slug (name + id suffix). */
    slug: { type: String, trim: true, lowercase: true, sparse: true, unique: true },
    avatar: { type: String, default: "" },
    banner: { type: String, default: "" },
    bio: { type: String, trim: true, default: "", maxlength: 1000 },
    location: { type: String, trim: true, default: "" },
    gender: { type: String, trim: true, default: "" },
    dateOfBirth: { type: String, trim: true, default: "" },
    website: { type: String, trim: true, default: "" },
    instagram: { type: String, trim: true, default: "" },
    linkedin: { type: String, trim: true, default: "" },
    twitter: { type: String, trim: true, default: "" },
    followers: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },
    following: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },
    passwordHash: { type: String, select: false },
    providers: {
      type: [
        {
          provider: {
            type: String,
            enum: ["email", "phone", "google", "apple"],
            required: true,
          },
          providerId: { type: String },
        },
      ],
      default: [],
    },
    countryCode: {
      type: String,
      enum: ["US", "CA", "IN"],
      default: "IN",
    },
    devices: {
      type: [
        {
          deviceId: String,
          platform: String,
          pushToken: String,
          lastSeenAt: Date,
        },
      ],
      default: [],
    },
    savedListingIds: { type: [String], default: [] },
    compareListingIds: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
    sellerPremium: {
      status: { type: String, default: "none" },
      isPremiumSeller: { type: Boolean, default: false },
      planKey: { type: String, default: "" },
      trialEndsAt: Date,
      currentPeriodStart: Date,
      currentPeriodEnd: Date,
      cancelAtPeriodEnd: { type: Boolean, default: false },
      trialUsed: { type: Boolean, default: false },
      freeBoostsRemaining: { type: Number, default: 0 },
      freeBoostsPerMonth: { type: Number, default: 3 },
      freeBoostsResetAt: Date,
      subscriptionId: { type: Schema.Types.ObjectId, ref: "SellerSubscription" },
      provider: { type: String, default: "" },
    },
  },
  { timestamps: true },
);

userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: "string" } } },
);
userSchema.index({ phone: 1 }, { sparse: true });

export type UserDocument = InferSchemaType<typeof userSchema> & {
  _id: mongoose.Types.ObjectId;
  countryCode: CountryCode;
};

export const User = mongoose.model("User", userSchema);
