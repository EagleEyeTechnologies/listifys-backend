import { z } from "zod";
import { User } from "./user.model.js";
import { Listing } from "../listings/listing.model.js";
import { AppError } from "../../utils/AppError.js";
import { publicPremiumStatus } from "../premium/premium.service.js";
import { getSellerReviewStats } from "../reviews/reviews.service.js";
import { isMongoObjectId, sellerSlugFrom } from "../../utils/slug.js";
import { issueOtp, verifyOtp } from "../auth/otp.js";
import { absolutizeMediaUrl } from "../../utils/mediaUrl.js";
import { displayEmail } from "../../utils/phone.js";

export const updateMeSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    avatar: z.union([z.string().max(4000), z.literal("")]).optional(),
    banner: z.union([z.string().max(4000), z.literal("")]).optional(),
    bio: z.string().max(1000).optional(),
    location: z.string().max(200).optional(),
    gender: z.string().max(40).optional(),
    dateOfBirth: z.string().max(20).optional(),
    website: z.string().max(300).optional(),
    instagram: z.string().max(120).optional(),
    linkedin: z.string().max(120).optional(),
    twitter: z.string().max(120).optional(),
    countryCode: z.enum(["US", "CA", "IN"]).optional(),
  })
  .strict();

export const changeEmailRequestSchema = z.object({
  email: z.string().email(),
});

export const changeEmailVerifySchema = z.object({
  email: z.string().email(),
  code: z.string().min(4).max(8),
});

export const changePhoneRequestSchema = z.object({
  phone: z.string().min(8).max(20),
  phoneCode: z.string().min(1).max(5).default("+91"),
});

export const changePhoneVerifySchema = z.object({
  phone: z.string().min(8).max(20),
  phoneCode: z.string().min(1).max(5).default("+91"),
  code: z.string().min(4).max(8),
});

function idsOf(arr?: unknown) {
  if (!Array.isArray(arr)) return [];
  return arr.map((id) => String(id));
}

function userPublicSlug(user: InstanceType<typeof User>) {
  if (user.slug) return user.slug;
  const generated = sellerSlugFrom(user.name || "seller", user._id.toString());
  user.slug = generated;
  void user.save().catch(() => undefined);
  return generated;
}

export function toMeUser(user: InstanceType<typeof User>) {
  const emailShown = displayEmail(user.email);
  return {
    id: user._id.toString(),
    slug: userPublicSlug(user),
    email: emailShown === "—" ? null : emailShown,
    phone: user.phone || null,
    phoneCode: user.phoneCode || null,
    name: user.name || "",
    avatar: absolutizeMediaUrl(user.avatar),
    banner: absolutizeMediaUrl(user.banner),
    bio: user.bio || "",
    location: user.location || "",
    gender: user.gender || "",
    dateOfBirth: user.dateOfBirth || "",
    website: user.website || "",
    instagram: user.instagram || "",
    linkedin: user.linkedin || "",
    twitter: user.twitter || "",
    countryCode: user.countryCode || "IN",
    savedListingIds: user.savedListingIds || [],
    compareListingIds: user.compareListingIds || [],
    followersCount: idsOf(user.followers).length,
    followingCount: idsOf(user.following).length,
    premium: publicPremiumStatus(user),
    createdAt:
      (user as InstanceType<typeof User> & { createdAt?: Date }).createdAt?.toISOString?.() ??
      null,
  };
}

export async function toPublicUser(
  user: InstanceType<typeof User>,
  viewerId?: string,
) {
  const stats = await getSellerReviewStats(user._id.toString());
  const listingCount = await Listing.countDocuments({
    seller: user._id,
    status: { $in: ["active", "sold", "paused"] },
  });
  const followerIds = idsOf(user.followers);
  const followingIds = idsOf(user.following);
  const id = user._id.toString();
  const slug = userPublicSlug(user);
  return {
    id,
    slug,
    name: user.name || "",
    avatar: absolutizeMediaUrl(user.avatar),
    banner: absolutizeMediaUrl(user.banner),
    bio: user.bio || "",
    location: user.location || "",
    countryCode: user.countryCode || "IN",
    createdAt:
      (user as InstanceType<typeof User> & { createdAt?: Date }).createdAt?.toISOString?.() ??
      null,
    averageRating: stats.averageRating,
    totalReviews: stats.totalReviews,
    listingCount,
    followersCount: followerIds.length,
    followingCount: followingIds.length,
    isFollowing: viewerId ? followerIds.includes(viewerId) : false,
  };
}

export async function requireUser(idOrSlug: string) {
  const user = await findUserByIdOrSlug(idOrSlug);
  if (!user || !user.isActive) {
    throw new AppError(404, "User not found", "NOT_FOUND");
  }
  return user;
}

export async function findUserByIdOrSlug(idOrSlug: string) {
  const key = String(idOrSlug || "").trim();
  if (!key) return null;
  if (isMongoObjectId(key)) {
    const byId = await User.findById(key);
    if (byId) return byId;
  }
  const bySlug = await User.findOne({ slug: key.toLowerCase() });
  if (bySlug) return bySlug;
  const short = key.match(/-([a-f0-9]{6})$/i)?.[1]?.toLowerCase();
  if (short) {
    return User.findOne({
      $expr: {
        $eq: [{ $substrCP: [{ $toString: "$_id" }, 18, 6] }, short],
      },
    });
  }
  return null;
}

/** Public profile even when the user doc is missing but listings still reference the seller id. */
export async function getPublicSellerProfile(
  idOrSlug: string,
  viewerId?: string,
) {
  const user = await findUserByIdOrSlug(idOrSlug);
  if (user && user.isActive) {
    return toPublicUser(user, viewerId);
  }

  const id = user?._id?.toString() || (isMongoObjectId(idOrSlug) ? idOrSlug : "");
  if (!id) {
    throw new AppError(404, "User not found", "NOT_FOUND");
  }

  const listings = await Listing.find({
    seller: id,
    status: { $in: ["active", "sold", "paused"] },
  })
    .sort({ updatedAt: -1 })
    .limit(50);

  if (!listings.length) {
    throw new AppError(404, "User not found", "NOT_FOUND");
  }

  const sample = listings[0];
  const activeCount = listings.filter((l) => l.status === "active").length;
  const stubSlug = sellerSlugFrom(sample.sellerName || "seller", id);
  return {
    id,
    slug: stubSlug,
    name: sample.sellerName || "Seller",
    avatar: absolutizeMediaUrl(sample.sellerAvatar),
    banner: "",
    bio: "",
    location: sample.city || sample.location || "",
    countryCode: sample.countryCode || "IN",
    createdAt: null,
    averageRating: 0,
    totalReviews: 0,
    listingCount: activeCount || listings.length,
    followersCount: 0,
    followingCount: 0,
    isFollowing: false,
    stub: true,
  };
}

export async function updateMe(
  userId: string,
  input: z.infer<typeof updateMeSchema>,
) {
  const user = await User.findById(userId);
  if (!user || !user.isActive) {
    throw new AppError(401, "User not found", "UNAUTHORIZED");
  }
  const fields = [
    "name",
    "avatar",
    "banner",
    "bio",
    "location",
    "gender",
    "dateOfBirth",
    "website",
    "instagram",
    "linkedin",
    "twitter",
    "countryCode",
  ] as const;
  for (const key of fields) {
    if (input[key] !== undefined) {
      (user as unknown as Record<string, unknown>)[key] = input[key];
    }
  }
  await user.save();
  return toMeUser(user);
}

export async function requestEmailChange(userId: string, emailRaw: string) {
  const email = emailRaw.trim().toLowerCase();
  const taken = await User.findOne({ email, _id: { $ne: userId } });
  if (taken) {
    throw new AppError(409, "Email already in use", "EMAIL_EXISTS");
  }
  return issueOtp("email", email);
}

export async function verifyEmailChange(
  userId: string,
  emailRaw: string,
  code: string,
) {
  const email = emailRaw.trim().toLowerCase();
  await verifyOtp("email", email, code);
  const user = await User.findById(userId);
  if (!user || !user.isActive) {
    throw new AppError(401, "User not found", "UNAUTHORIZED");
  }
  const taken = await User.findOne({ email, _id: { $ne: userId } });
  if (taken) {
    throw new AppError(409, "Email already in use", "EMAIL_EXISTS");
  }
  user.email = email;
  if (!user.providers?.some((p) => p.provider === "email")) {
    user.providers.push({ provider: "email", providerId: email });
  }
  await user.save();
  return toMeUser(user);
}

export async function requestPhoneChange(
  userId: string,
  phone: string,
  phoneCode: string,
) {
  const taken = await User.findOne({ phone, _id: { $ne: userId } });
  if (taken) {
    throw new AppError(409, "Phone already in use", "PHONE_EXISTS");
  }
  return issueOtp("phone", `${phoneCode}:${phone}`);
}

export async function verifyPhoneChange(
  userId: string,
  phone: string,
  phoneCode: string,
  code: string,
) {
  await verifyOtp("phone", `${phoneCode}:${phone}`, code);
  const user = await User.findById(userId);
  if (!user || !user.isActive) {
    throw new AppError(401, "User not found", "UNAUTHORIZED");
  }
  const taken = await User.findOne({ phone, _id: { $ne: userId } });
  if (taken) {
    throw new AppError(409, "Phone already in use", "PHONE_EXISTS");
  }
  user.phone = phone;
  user.phoneCode = phoneCode;
  if (!user.providers?.some((p) => p.provider === "phone")) {
    user.providers.push({
      provider: "phone",
      providerId: `${phoneCode}:${phone}`,
    });
  }
  await user.save();
  return toMeUser(user);
}

async function personFromUser(
  user: InstanceType<typeof User>,
  viewerFollowing: string[],
) {
  const stats = await getSellerReviewStats(user._id.toString());
  const listingCount = await Listing.countDocuments({
    seller: user._id,
    status: "active",
  });
  const id = user._id.toString();
  const slug = userPublicSlug(user);
  return {
    id,
    slug,
    name: user.name || "User",
    avatar: absolutizeMediaUrl(user.avatar),
    location: user.location || user.countryCode || "",
    listingCount,
    rating: stats.averageRating,
    verified: false,
    isFollowing: viewerFollowing.includes(id),
    href: `/sellerprofile/${slug}`,
  };
}

export async function listConnections(
  userId: string,
  mode: "followers" | "following",
  viewerId?: string,
) {
  const user = await requireUser(userId);
  const ids = idsOf(mode === "followers" ? user.followers : user.following);
  if (!ids.length) return [];
  const people = await User.find({ _id: { $in: ids }, isActive: true });
  const viewer = viewerId ? await User.findById(viewerId) : user;
  const viewerFollowing = idsOf(viewer?.following);
  return Promise.all(people.map((p) => personFromUser(p, viewerFollowing)));
}

export async function toggleFollow(viewerId: string, targetId: string) {
  if (viewerId === targetId) {
    throw new AppError(400, "Cannot follow yourself", "VALIDATION_ERROR");
  }
  const [viewer, target] = await Promise.all([
    User.findById(viewerId),
    requireUser(targetId),
  ]);
  if (!viewer || !viewer.isActive) {
    throw new AppError(401, "User not found", "UNAUTHORIZED");
  }

  const already = idsOf(viewer.following).includes(targetId);
  if (already) {
    viewer.following = (viewer.following || []).filter(
      (id) => String(id) !== targetId,
    ) as typeof viewer.following;
    target.followers = (target.followers || []).filter(
      (id) => String(id) !== viewerId,
    ) as typeof target.followers;
  } else {
    viewer.following = [
      ...(viewer.following || []),
      target._id,
    ] as typeof viewer.following;
    target.followers = [
      ...(target.followers || []),
      viewer._id,
    ] as typeof target.followers;
  }
  await Promise.all([viewer.save(), target.save()]);
  return {
    following: !already,
    followersCount: idsOf(target.followers).length,
    followingCount: idsOf(viewer.following).length,
  };
}

export async function removeFollower(userId: string, followerId: string) {
  const [user, follower] = await Promise.all([
    User.findById(userId),
    User.findById(followerId),
  ]);
  if (!user || !user.isActive) {
    throw new AppError(401, "User not found", "UNAUTHORIZED");
  }
  user.followers = (user.followers || []).filter(
    (id) => String(id) !== followerId,
  ) as typeof user.followers;
  if (follower) {
    follower.following = (follower.following || []).filter(
      (id) => String(id) !== userId,
    ) as typeof follower.following;
    await follower.save();
  }
  await user.save();
  return { ok: true };
}
