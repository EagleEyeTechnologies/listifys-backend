import mongoose from "mongoose";
import { z } from "zod";
import { CATEGORY_SLUGS, type CategorySlug } from "../../types/domain.js";
import { Listing } from "../listings/listing.model.js";
import { Payment } from "../payments/payment.model.js";
import { Address } from "../users/address.model.js";
import { User } from "../users/user.model.js";
import { AppError } from "../../utils/AppError.js";
import { absolutizeMediaUrl } from "../../utils/mediaUrl.js";
import { displayEmail, formatPhoneDisplay, isSyntheticEmail } from "../../utils/phone.js";
import { countOpenModerationReports } from "./admin.platform.service.js";

function isOAuthVerified(providers?: Array<{ provider?: string }> | null): boolean {
  return Boolean(providers?.some((p) => p.provider === "google" || p.provider === "apple"));
}

function formatAddressLabel(a: {
  label?: string | null;
  city?: string | null;
  formattedAddress?: string | null;
}): string {
  const label = (a.label || "").trim();
  const city = (a.city || "").trim();
  const formatted = (a.formattedAddress || "").trim();
  if (label && city) return `${label} · ${city}`;
  if (city) return city;
  if (label && formatted) return `${label} · ${formatted}`;
  if (formatted) {
    const short = formatted.split(",").slice(0, 2).join(",").trim();
    return short || formatted;
  }
  return label || "—";
}

function initials(name: string, email?: string | null) {
  const base = (name || email || "?").trim();
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
  }
  return base.slice(0, 2).toUpperCase();
}

function formatDate(d?: Date | null) {
  if (!d) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function relativeTime(d?: Date | null) {
  if (!d) return "—";
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return formatDate(d);
}

function formatPrice(price: number, currency: string, countryCode: string) {
  if (currency === "INR" || countryCode === "IN") {
    return `₹${Number(price).toLocaleString("en-IN")}`;
  }
  if (currency === "USD" || countryCode === "US") {
    return `$${Number(price).toLocaleString("en-US")}`;
  }
  if (currency === "CAD" || countryCode === "CA") {
    return `C$${Number(price).toLocaleString("en-CA")}`;
  }
  return `${currency} ${Number(price).toLocaleString()}`;
}

function lastSeenFromDevices(devices?: Array<{ lastSeenAt?: Date | null }> | null) {
  if (!devices?.length) return null;
  let latest: Date | null = null;
  for (const d of devices) {
    if (!d.lastSeenAt) continue;
    const t = new Date(d.lastSeenAt);
    if (!latest || t > latest) latest = t;
  }
  return latest;
}

export async function getAdminMe(userId: string) {
  const user = await User.findById(userId).select("email name avatar countryCode isActive");
  if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
  return {
    id: user._id.toString(),
    email: user.email || "",
    name: user.name || "",
    avatar: user.avatar || "",
    countryCode: user.countryCode || "IN",
  };
}

export const adminUsersQuerySchema = z.object({
  q: z.string().optional(),
  market: z.enum(["IN", "US", "CA", "all"]).optional().default("all"),
  status: z.enum(["active", "inactive", "all"]).optional().default("all"),
  premium: z.enum(["yes", "no", "all"]).optional().default("all"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export async function listAdminUsers(query: z.infer<typeof adminUsersQuerySchema>) {
  const filter: Record<string, unknown> = {};
  if (query.market !== "all") filter.countryCode = query.market;
  if (query.status === "active") filter.isActive = true;
  if (query.status === "inactive") filter.isActive = false;
  if (query.premium === "yes") filter["sellerPremium.isPremiumSeller"] = true;
  if (query.premium === "no") {
    filter.$or = [
      { "sellerPremium.isPremiumSeller": { $ne: true } },
      { sellerPremium: { $exists: false } },
    ];
  }
  if (query.q?.trim()) {
    const q = query.q.trim();
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$and = [
      ...(Array.isArray(filter.$and) ? (filter.$and as object[]) : []),
      {
        $or: [{ name: rx }, { email: rx }, { phone: rx }, { location: rx }],
      },
    ];
  }

  const skip = (query.page - 1) * query.limit;
  const [total, users] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean(),
  ]);

  const ids = users.map((u) => u._id);
  const [listingCounts, addresses, listingCities] = await Promise.all([
    Listing.aggregate<{
      _id: mongoose.Types.ObjectId;
      count: number;
    }>([
      { $match: { seller: { $in: ids }, status: { $ne: "removed" } } },
      { $group: { _id: "$seller", count: { $sum: 1 } } },
    ]),
    Address.find({ user: { $in: ids } })
      .sort({ isDefault: -1, updatedAt: -1 })
      .lean(),
    Listing.aggregate<{
      _id: mongoose.Types.ObjectId;
      city: string;
    }>([
      {
        $match: {
          seller: { $in: ids },
          status: { $ne: "removed" },
          $or: [
            { city: { $exists: true, $nin: [null, ""] } },
            { location: { $exists: true, $nin: [null, ""] } },
          ],
        },
      },
      {
        $group: {
          _id: "$seller",
          city: { $first: { $ifNull: ["$city", "$location"] } },
        },
      },
    ]),
  ]);
  const countMap = new Map(listingCounts.map((r) => [r._id.toString(), r.count]));
  const addressMap = new Map<string, string>();
  for (const a of addresses as Array<{
    user: mongoose.Types.ObjectId;
    label?: string;
    city?: string;
    formattedAddress?: string;
    isDefault?: boolean;
  }>) {
    const uid = a.user.toString();
    if (addressMap.has(uid)) continue;
    addressMap.set(uid, formatAddressLabel(a));
  }
  const cityMap = new Map(
    listingCities.map((r) => [r._id.toString(), String(r.city || "").trim()]),
  );

  const items = users.map((u) => {
    const lastSeen = lastSeenFromDevices(u.devices as Array<{ lastSeenAt?: Date }> | undefined);
    const uid = u._id.toString();
    const location = addressMap.get(uid) || (u.location || "").trim() || cityMap.get(uid) || "—";
    const emailRaw = u.email || "";
    return {
      id: uid,
      name: u.name || "—",
      email: displayEmail(emailRaw),
      phone: formatPhoneDisplay(u.phoneCode, u.phone),
      verified: isOAuthVerified(u.providers as Array<{ provider?: string }> | undefined),
      premium: Boolean(u.sellerPremium?.isPremiumSeller),
      market: (u.countryCode || "IN") as "IN" | "US" | "CA",
      location,
      listings: countMap.get(uid) || 0,
      status: u.isActive ? ("Active" as const) : ("Inactive" as const),
      joinedOn: formatDate(u.createdAt as Date | undefined),
      lastActive: relativeTime(lastSeen),
      avatar: initials(u.name || "", isSyntheticEmail(emailRaw) ? undefined : emailRaw),
      avatarUrl: absolutizeMediaUrl(u.avatar),
    };
  });

  return {
    items,
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

export const patchAdminUserSchema = z.object({
  isActive: z.boolean().optional(),
});

export async function patchAdminUser(id: string, body: z.infer<typeof patchAdminUserSchema>) {
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(400, "Invalid user id", "VALIDATION_ERROR");
  }
  const user = await User.findById(id);
  if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
  if (typeof body.isActive === "boolean") user.isActive = body.isActive;
  await user.save();
  return {
    id: user._id.toString(),
    isActive: user.isActive,
    status: user.isActive ? "Active" : "Inactive",
  };
}

export const adminListingsQuerySchema = z.object({
  q: z.string().optional(),
  category: z
    .enum(["all", ...CATEGORY_SLUGS] as [string, ...string[]])
    .optional()
    .default("all"),
  intent: z.enum(["all", "sale", "wanted", "free"]).optional().default("all"),
  status: z
    .enum(["all", "active", "sold", "paused", "expired", "removed"])
    .optional()
    .default("all"),
  market: z.enum(["IN", "US", "CA", "all"]).optional().default("all"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export async function listAdminListings(query: z.infer<typeof adminListingsQuerySchema>) {
  const filter: Record<string, unknown> = {};
  if (query.category !== "all") filter.category = query.category;
  if (query.intent !== "all") filter.intent = query.intent;
  if (query.status !== "all") filter.status = query.status;
  if (query.market !== "all") filter.countryCode = query.market;
  if (query.q?.trim()) {
    const q = query.q.trim();
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ title: rx }, { sellerName: rx }, { location: rx }, { city: rx }, { slug: rx }];
  }

  const skip = (query.page - 1) * query.limit;
  const [total, listings] = await Promise.all([
    Listing.countDocuments(filter),
    Listing.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean(),
  ]);

  const items = listings.map((l) => ({
    id: l._id.toString(),
    code: `#${l._id.toString().slice(-6).toUpperCase()}`,
    title: l.title,
    category: l.category as CategorySlug,
    intent: l.intent as "sale" | "wanted" | "free",
    price: formatPrice(l.price, l.currency || "INR", l.countryCode || "IN"),
    location: l.city || l.location || "—",
    market: (l.countryCode || "IN") as "IN" | "US" | "CA",
    postedBy: l.sellerName || "—",
    postedByAvatar: initials(l.sellerName || "U"),
    sellerId: l.seller?.toString?.() || String(l.seller),
    status: l.status as "active" | "sold" | "paused" | "expired" | "removed",
    boosted: Boolean(l.featured),
    views: String(l.views || 0),
    postedOn: relativeTime(l.createdAt as Date | undefined),
    thumb: Array.isArray(l.images) && l.images[0] ? l.images[0] : "📦",
    imageUrl: Array.isArray(l.images) && l.images[0] ? l.images[0] : "",
  }));

  return {
    items,
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

export const patchAdminListingSchema = z.object({
  status: z.enum(["active", "sold", "paused", "expired", "removed"]).optional(),
  title: z.string().min(3).max(200).optional(),
  description: z.string().min(10).max(10000).optional(),
  category: z.enum(CATEGORY_SLUGS).optional(),
  subcategory: z.string().max(120).optional(),
  subSubcategory: z.string().max(120).optional(),
  intent: z.enum(["sale", "wanted", "free"]).optional(),
  price: z.number().min(0).optional(),
  currency: z.string().min(3).max(3).optional(),
  condition: z.string().max(80).optional(),
  location: z.string().min(2).max(200).optional(),
  city: z.string().min(2).max(120).optional(),
  countryCode: z.enum(["US", "CA", "IN"]).optional(),
  featured: z.boolean().optional(),
  images: z.array(z.string().min(1)).max(20).optional(),
});

export async function getAdminListing(id: string) {
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(400, "Invalid listing id", "VALIDATION_ERROR");
  }
  const listing = await Listing.findById(id).lean();
  if (!listing) throw new AppError(404, "Listing not found", "NOT_FOUND");
  return {
    id: listing._id.toString(),
    title: listing.title || "",
    description: listing.description || "",
    category: listing.category,
    subcategory: listing.subcategory || "",
    subSubcategory: listing.subSubcategory || "",
    intent: listing.intent as "sale" | "wanted" | "free",
    price: listing.price,
    currency: listing.currency || "INR",
    condition: listing.condition || "",
    location: listing.location || "",
    city: listing.city || "",
    countryCode: (listing.countryCode || "IN") as "IN" | "US" | "CA",
    status: listing.status as "active" | "sold" | "paused" | "expired" | "removed",
    featured: Boolean(listing.featured),
    images: Array.isArray(listing.images) ? listing.images.map((u) => absolutizeMediaUrl(u)) : [],
    sellerName: listing.sellerName || "",
    postedOn: formatDate(listing.createdAt as Date | undefined),
  };
}

export async function patchAdminListing(id: string, body: z.infer<typeof patchAdminListingSchema>) {
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(400, "Invalid listing id", "VALIDATION_ERROR");
  }
  const listing = await Listing.findById(id);
  if (!listing) throw new AppError(404, "Listing not found", "NOT_FOUND");

  if (body.status !== undefined) listing.status = body.status;
  if (body.title !== undefined) listing.title = body.title;
  if (body.description !== undefined) listing.description = body.description;
  if (body.category !== undefined) listing.category = body.category;
  if (body.subcategory !== undefined) listing.subcategory = body.subcategory;
  if (body.subSubcategory !== undefined) {
    listing.subSubcategory = body.subSubcategory;
  }
  if (body.intent !== undefined) listing.intent = body.intent;
  if (body.price !== undefined) listing.price = body.price;
  if (body.currency !== undefined) listing.currency = body.currency;
  if (body.condition !== undefined) listing.condition = body.condition;
  if (body.location !== undefined) listing.location = body.location;
  if (body.city !== undefined) listing.city = body.city;
  if (body.countryCode !== undefined) listing.countryCode = body.countryCode;
  if (body.featured !== undefined) listing.featured = body.featured;
  if (body.images !== undefined) listing.images = body.images;

  await listing.save();

  try {
    const { indexListing } = await import("../search/search.service.js");
    await indexListing(listing);
  } catch {
    /* search optional */
  }

  return {
    id: listing._id.toString(),
    status: listing.status,
    title: listing.title,
    price: listing.price,
  };
}

export async function softDeleteAdminListing(id: string) {
  return patchAdminListing(id, { status: "removed" });
}

export async function getAdminStats() {
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    totalUsers,
    activeUsers,
    inactiveUsers,
    premiumUsers,
    newUsers30,
    totalListings,
    activeListings,
    soldListings,
    pausedListings,
    expiredListings,
    boostedListings,
    monetizationAgg,
    purposeAgg,
    revenueByMonthAgg,
    usersByDayAgg,
    categoryCounts,
    recentUsers,
    recentListings,
    openReports,
  ] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ isActive: true }),
    User.countDocuments({ isActive: false }),
    User.countDocuments({ "sellerPremium.isPremiumSeller": true }),
    User.countDocuments({ createdAt: { $gte: since30 } }),
    Listing.countDocuments({ status: { $ne: "removed" } }),
    Listing.countDocuments({ status: "active" }),
    Listing.countDocuments({ status: "sold" }),
    Listing.countDocuments({ status: "paused" }),
    Listing.countDocuments({ status: "expired" }),
    Listing.countDocuments({ featured: true, status: { $ne: "removed" } }),
    Payment.aggregate<{ total: number }>([
      { $match: { status: "succeeded", createdAt: { $gte: since30 } } },
      { $group: { _id: null, total: { $sum: "$totalMinor" } } },
    ]).catch(() => [] as { total: number }[]),
    Payment.aggregate<{ _id: string; total: number }>([
      { $match: { status: "succeeded", createdAt: { $gte: since30 } } },
      { $group: { _id: "$purpose", total: { $sum: "$totalMinor" } } },
    ]).catch(() => [] as { _id: string; total: number }[]),
    Payment.aggregate<{ _id: { y: number; m: number }; total: number }>([
      {
        $match: {
          status: "succeeded",
          createdAt: { $gte: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) },
        },
      },
      {
        $group: {
          _id: { y: { $year: "$createdAt" }, m: { $month: "$createdAt" } },
          total: { $sum: "$totalMinor" },
        },
      },
      { $sort: { "_id.y": 1, "_id.m": 1 } },
    ]).catch(() => [] as { _id: { y: number; m: number }; total: number }[]),
    User.aggregate<{ _id: string; count: number }>([
      { $match: { createdAt: { $gte: since7 } } },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]).catch(() => [] as { _id: string; count: number }[]),
    getAdminCategoryCounts(),
    User.find({}).sort({ createdAt: -1 }).limit(5).lean(),
    Listing.find({ status: { $ne: "removed" } })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean(),
    countOpenModerationReports(),
  ]);

  const monetizationMinor = monetizationAgg[0]?.total || 0;
  const purposeMap = Object.fromEntries(purposeAgg.map((p) => [p._id, p.total])) as Record<
    string,
    number
  >;
  const purposeTotal =
    (purposeMap.boost || 0) +
    (purposeMap.premium_subscription || 0) +
    (purposeMap.event_ticket || 0);
  const pct = (n: number) => (purposeTotal > 0 ? Math.round((n / purposeTotal) * 100) : 0);

  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const revenueByMonth = revenueByMonthAgg.map((r) => ({
    month: monthNames[(r._id.m || 1) - 1] || String(r._id.m),
    revenue: Math.round(r.total / 100),
  }));

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const usersByDayMap = new Map(usersByDayAgg.map((d) => [d._id, d.count]));
  const userGrowth7d = Array.from({ length: 7 }).map((_, i) => {
    const d = new Date(since7.getTime() + i * 86400000);
    const key = d.toISOString().slice(0, 10);
    return {
      day: dayNames[d.getDay()] || key,
      users: usersByDayMap.get(key) || 0,
    };
  });

  return {
    totalUsers,
    activeUsers,
    inactiveUsers,
    premiumUsers,
    newUsers30,
    totalListings,
    activeListings,
    soldListings,
    pausedListings,
    expiredListings,
    boostedListings,
    openReports,
    monetization30d:
      monetizationMinor > 0
        ? `₹${(monetizationMinor / 100).toLocaleString("en-IN", {
            maximumFractionDigits: 0,
          })}`
        : "₹0",
    monetizationMinor,
    paymentsByPurpose: [
      {
        name: "Boost",
        value: pct(purposeMap.boost || 0),
        color: "#2563eb",
        amountMinor: purposeMap.boost || 0,
      },
      {
        name: "Premium",
        value: pct(purposeMap.premium_subscription || 0),
        color: "#7c3aed",
        amountMinor: purposeMap.premium_subscription || 0,
      },
      {
        name: "Event Tickets",
        value: pct(purposeMap.event_ticket || 0),
        color: "#16a34a",
        amountMinor: purposeMap.event_ticket || 0,
      },
    ],
    revenueByMonth,
    userGrowth7d,
    categoryCounts,
    recentUsers: recentUsers.map((u) => {
      const emailRaw = u.email || "";
      return {
        id: u._id.toString(),
        name: u.name || "—",
        email: displayEmail(emailRaw),
        premium: Boolean(u.sellerPremium?.isPremiumSeller),
        market: (u.countryCode || "IN") as "IN" | "US" | "CA",
        avatar: initials(u.name || "", isSyntheticEmail(emailRaw) ? undefined : emailRaw),
        avatarUrl: absolutizeMediaUrl(u.avatar),
      };
    }),
    recentListings: recentListings.map((l) => ({
      id: l._id.toString(),
      title: l.title,
      category: l.category,
      price: formatPrice(l.price, l.currency || "INR", l.countryCode || "IN"),
      status: l.status,
      thumb: Array.isArray(l.images) && l.images[0] ? absolutizeMediaUrl(l.images[0]) : "",
    })),
  };
}

export async function getAdminCategoryCounts() {
  const rows = await Listing.aggregate<{
    _id: string;
    listings: number;
    active: number;
  }>([
    {
      $group: {
        _id: "$category",
        listings: {
          $sum: { $cond: [{ $ne: ["$status", "removed"] }, 1, 0] },
        },
        active: {
          $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] },
        },
      },
    },
    { $sort: { listings: -1 } },
  ]);

  return rows.map((r) => ({
    slug: r._id,
    listings: r.listings,
    active: r.active,
  }));
}

function moneyLabel(minor: number, currency = "INR") {
  const major = minor / 100;
  if (currency === "INR") return `₹${major.toLocaleString("en-IN")}`;
  if (currency === "USD") return `$${major.toLocaleString("en-US")}`;
  return `${currency} ${major.toLocaleString()}`;
}

export const pageQuerySchema = z.object({
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().optional().default("all"),
});

export async function listAdminPayments(
  query: z.infer<typeof pageQuerySchema> & {
    purpose?: string;
    provider?: string;
  },
) {
  const filter: Record<string, unknown> = {};
  if (query.status && query.status !== "all") filter.status = query.status;
  if (query.purpose && query.purpose !== "all") filter.purpose = query.purpose;
  if (query.provider && query.provider !== "all") filter.provider = query.provider;
  if (query.q?.trim()) {
    const rx = new RegExp(query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ providerOrderId: rx }, { providerPaymentId: rx }, { planKey: rx }];
  }
  const skip = (query.page - 1) * query.limit;
  const [total, rows, stats] = await Promise.all([
    Payment.countDocuments(filter),
    Payment.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(query.limit)
      .populate("userId", "name email avatar")
      .lean(),
    Payment.aggregate([
      { $match: { createdAt: { $gte: new Date(Date.now() - 30 * 86400000) } } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          total: { $sum: "$totalMinor" },
        },
      },
    ]),
  ]);

  const byPurpose = await Payment.aggregate([
    { $match: { status: "succeeded", createdAt: { $gte: new Date(Date.now() - 30 * 86400000) } } },
    { $group: { _id: "$purpose", total: { $sum: "$totalMinor" } } },
  ]);

  const purposeTotals = Object.fromEntries(byPurpose.map((p) => [p._id, p.total]));
  const succeeded = stats.find((s) => s._id === "succeeded");

  return {
    items: rows.map((p) => {
      const user = p.userId as {
        name?: string;
        email?: string;
        avatar?: string;
        _id?: { toString(): string };
      } | null;
      return {
        id: p._id.toString(),
        user: user?.name || user?.email || "—",
        avatar: initials(user?.name || "", user?.email),
        purpose: p.purpose,
        related: p.planKey || "—",
        amount: moneyLabel(p.totalMinor, p.currency),
        provider: String(p.provider || "").replace(/^\w/, (c) => c.toUpperCase()),
        method: p.providerOrderId ? "Online" : "—",
        status:
          p.status === "succeeded"
            ? "Successful"
            : p.status === "pending"
              ? "Pending"
              : p.status === "failed"
                ? "Failed"
                : p.status === "refunded"
                  ? "Refunded"
                  : String(p.status),
        datetime:
          formatDate(p.createdAt as Date) +
          (p.createdAt
            ? `, ${(p.createdAt as Date).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`
            : ""),
      };
    }),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
    stats: {
      revenue30d: moneyLabel(succeeded?.total || 0),
      boost30d: moneyLabel(purposeTotals.boost || 0),
      premium30d: moneyLabel(purposeTotals.premium_subscription || 0),
      tickets30d: moneyLabel(purposeTotals.event_ticket || 0),
      failedRefunded: moneyLabel(
        (stats.find((s) => s._id === "failed")?.total || 0) +
          (stats.find((s) => s._id === "refunded")?.total || 0),
      ),
    },
  };
}

export async function listAdminBoosts(query: z.infer<typeof pageQuerySchema>) {
  const { BoostCampaign } = await import("../boost/boostCampaign.model.js");
  const filter: Record<string, unknown> = {};
  if (query.status && query.status !== "all") {
    filter.status =
      query.status === "Active"
        ? "active"
        : query.status === "Expired"
          ? "expired"
          : query.status === "Scheduled"
            ? "pending_payment"
            : query.status.toLowerCase();
  }
  if (query.q?.trim()) {
    const rx = new RegExp(query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ listingTitle: rx }, { planKey: rx }];
  }
  const skip = (query.page - 1) * query.limit;
  const [total, rows, active, campaigns30, revenueAgg] = await Promise.all([
    BoostCampaign.countDocuments(filter),
    BoostCampaign.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(query.limit)
      .populate("userId", "name email")
      .lean(),
    BoostCampaign.countDocuments({ status: "active" }),
    BoostCampaign.countDocuments({ createdAt: { $gte: new Date(Date.now() - 30 * 86400000) } }),
    BoostCampaign.aggregate([
      {
        $match: {
          status: { $in: ["active", "expired"] },
          createdAt: { $gte: new Date(Date.now() - 30 * 86400000) },
        },
      },
      { $group: { _id: null, total: { $sum: "$totalMinor" } } },
    ]),
  ]);

  return {
    items: rows.map((b) => {
      const user = b.userId as { name?: string; email?: string } | null;
      return {
        id: b._id.toString(),
        listing: b.listingTitle || String(b.listingId),
        seller: user?.name || user?.email || "—",
        plan: `${b.planDays}-day ${b.planKey}`,
        status:
          b.status === "active"
            ? "Active"
            : b.status === "expired"
              ? "Expired"
              : b.status === "pending_payment"
                ? "Scheduled"
                : String(b.status),
        starts: formatDate(b.startAt as Date | undefined),
        ends: formatDate(b.endAt as Date | undefined),
        spend: moneyLabel(b.totalMinor, b.currency),
      };
    }),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
    stats: {
      active,
      campaigns30,
      revenue30d: moneyLabel(revenueAgg[0]?.total || 0),
    },
  };
}

export async function listAdminPremium(query: z.infer<typeof pageQuerySchema>) {
  const { SellerSubscription } = await import("../premium/sellerSubscription.model.js");
  const filter: Record<string, unknown> = {};
  if (query.status && query.status !== "all") {
    const map: Record<string, string> = {
      Active: "active",
      Trial: "trialing",
      Cancelled: "cancelled",
      Expired: "expired",
    };
    filter.status = map[query.status] || query.status.toLowerCase();
  }
  const skip = (query.page - 1) * query.limit;
  const [total, rows, active, trial, cancelled30] = await Promise.all([
    SellerSubscription.countDocuments(filter),
    SellerSubscription.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(query.limit)
      .populate("userId", "name email avatar")
      .lean(),
    SellerSubscription.countDocuments({ status: "active" }),
    SellerSubscription.countDocuments({ status: "trialing" }),
    SellerSubscription.countDocuments({
      status: "cancelled",
      cancelledAt: { $gte: new Date(Date.now() - 30 * 86400000) },
    }),
  ]);

  return {
    items: rows.map((s) => {
      const user = s.userId as { name?: string; email?: string; avatar?: string } | null;
      return {
        id: s._id.toString(),
        seller: user?.name || user?.email || "—",
        avatar: initials(user?.name || "", user?.email),
        plan: s.planKey || "Monthly",
        status:
          s.status === "active"
            ? "Active"
            : s.status === "trialing"
              ? "Trial"
              : s.status === "cancelled"
                ? "Cancelled"
                : s.status === "expired"
                  ? "Expired"
                  : String(s.status),
        started:
          formatDate(s.activatedAt as Date | undefined) ||
          formatDate(s.createdAt as Date | undefined),
        renews: formatDate(s.currentPeriodEnd as Date | undefined),
        amount:
          s.status === "trialing" ? "Free trial" : moneyLabel(s.totalMinor, s.currency) + "/mo",
      };
    }),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
    stats: { active, trial, cancelled30 },
  };
}

export async function listAdminEventBookings(query: z.infer<typeof pageQuerySchema>) {
  const { EventBooking } = await import("../event-tickets/eventBooking.model.js");
  const filter: Record<string, unknown> = {};
  if (query.status && query.status !== "all") {
    const map: Record<string, string> = {
      Confirmed: "confirmed",
      Pending: "pending_payment",
      Cancelled: "cancelled",
      Refunded: "refunded",
    };
    filter.status = map[query.status] || query.status.toLowerCase();
  }
  if (query.q?.trim()) {
    const rx = new RegExp(query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ eventTitle: rx }, { attendeeName: rx }, { attendeePhone: rx }];
  }
  const skip = (query.page - 1) * query.limit;
  const since30 = new Date(Date.now() - 30 * 86400000);
  const [total, rows, bookings30, ticketsAgg, revenueAgg, cancelled] = await Promise.all([
    EventBooking.countDocuments(filter),
    EventBooking.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(query.limit)
      .populate("userId", "name email avatar")
      .lean(),
    EventBooking.countDocuments({ createdAt: { $gte: since30 } }),
    EventBooking.aggregate([
      { $match: { status: "confirmed", createdAt: { $gte: since30 } } },
      { $group: { _id: null, tickets: { $sum: "$ticketQuantity" } } },
    ]),
    EventBooking.aggregate([
      { $match: { status: "confirmed", createdAt: { $gte: since30 } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]),
    EventBooking.countDocuments({ status: "cancelled", createdAt: { $gte: since30 } }),
  ]);

  return {
    items: rows.map((b) => {
      const user = b.userId as { name?: string; email?: string; avatar?: string } | null;
      const sym = b.currencySymbol || (b.currency === "INR" ? "₹" : "$");
      return {
        id: b._id.toString(),
        event: b.eventTitle || "Event",
        attendee: b.attendeeName || user?.name || user?.email || "—",
        avatar: initials(b.attendeeName || user?.name || "", user?.email),
        tickets: b.ticketQuantity,
        amount: `${sym}${Number(b.totalAmount).toLocaleString()}`,
        status:
          b.status === "confirmed"
            ? "Confirmed"
            : b.status === "pending_payment"
              ? "Pending"
              : b.status === "cancelled"
                ? "Cancelled"
                : b.status === "refunded"
                  ? "Refunded"
                  : String(b.status),
        bookedOn: formatDate(b.createdAt as Date | undefined),
      };
    }),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
    stats: {
      bookings30,
      tickets30: ticketsAgg[0]?.tickets || 0,
      revenue30d: revenueAgg[0]?.total
        ? `₹${Number(revenueAgg[0].total).toLocaleString("en-IN")}`
        : "₹0",
      cancelled30: cancelled,
    },
  };
}

export async function listAdminReviews(
  query: z.infer<typeof pageQuerySchema> & { rating?: string },
) {
  const { SellerReview } = await import("../reviews/sellerReview.model.js");
  const filter: Record<string, unknown> = {};
  if (query.status && query.status !== "all") {
    filter.status =
      query.status === "Visible"
        ? "published"
        : query.status === "Hidden"
          ? "hidden"
          : query.status === "Reported"
            ? "flagged"
            : query.status.toLowerCase();
  }
  if (query.rating && query.rating !== "all") {
    filter.rating = Number(query.rating);
  }
  if (query.q?.trim()) {
    const rx = new RegExp(query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.comment = rx;
  }
  const skip = (query.page - 1) * query.limit;
  const [total, rows, published, hidden, avgAgg] = await Promise.all([
    SellerReview.countDocuments(filter),
    SellerReview.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(query.limit)
      .populate("reviewer", "name email avatar")
      .populate("seller", "name email")
      .lean(),
    SellerReview.countDocuments({ status: "published" }),
    SellerReview.countDocuments({ status: "hidden" }),
    SellerReview.aggregate([{ $group: { _id: null, avg: { $avg: "$rating" } } }]),
  ]);

  return {
    items: rows.map((r) => {
      const reviewer = r.reviewer as { name?: string; email?: string } | null;
      const seller = r.seller as { name?: string; email?: string } | null;
      return {
        id: r._id.toString(),
        reviewer: reviewer?.name || reviewer?.email || "—",
        avatar: initials(reviewer?.name || "", reviewer?.email),
        seller: seller?.name || seller?.email || "—",
        rating: r.rating,
        comment: r.comment,
        date: formatDate(r.createdAt as Date | undefined),
        status:
          r.status === "published" ? "Visible" : r.status === "hidden" ? "Hidden" : "Reported",
      };
    }),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
    stats: {
      total: published + hidden,
      published,
      hidden,
      avgRating: Number((avgAgg[0]?.avg || 0).toFixed(1)),
    },
  };
}

export const patchAdminReviewSchema = z.object({
  status: z.enum(["published", "hidden", "flagged"]),
});

export async function patchAdminReview(id: string, body: z.infer<typeof patchAdminReviewSchema>) {
  const { SellerReview } = await import("../reviews/sellerReview.model.js");
  if (!mongoose.isValidObjectId(id)) throw new AppError(400, "Invalid id", "VALIDATION_ERROR");
  const review = await SellerReview.findById(id).populate("reviewer", "name email");
  if (!review) throw new AppError(404, "Review not found", "NOT_FOUND");
  review.status = body.status;
  await review.save();

  if (body.status === "flagged") {
    const { createAdminFlagReport } = await import("./report.service.js");
    const reviewer = review.reviewer as { name?: string; email?: string } | null;
    await createAdminFlagReport({
      type: "review",
      subject: `Review by ${reviewer?.name || reviewer?.email || "user"}`,
      subjectId: review._id.toString(),
      reviewId: review._id.toString(),
      userId: review.seller?.toString?.() || String(review.seller),
      listingId: review.listing ? String(review.listing) : undefined,
      reason: review.comment?.slice(0, 200) || "Admin flagged review",
    });
  }

  return { id: review._id.toString(), status: review.status };
}

export async function listAdminConversations(query: z.infer<typeof pageQuerySchema>) {
  const { Conversation } = await import("../chat/conversation.model.js");
  const { Message } = await import("../chat/message.model.js");
  const filter: Record<string, unknown> = {};
  if (query.q?.trim()) {
    const rx = new RegExp(query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ listingTitle: rx }, { lastMessageText: rx }];
  }
  const skip = (query.page - 1) * query.limit;
  const [total, rows] = await Promise.all([
    Conversation.countDocuments(filter),
    Conversation.find(filter)
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .skip(skip)
      .limit(query.limit)
      .populate("participants", "name email avatar")
      .lean(),
  ]);

  const items = await Promise.all(
    rows.map(async (c) => {
      const parts = (c.participants || []) as Array<{
        _id: { toString(): string };
        name?: string;
        email?: string;
        avatar?: string;
      }>;
      const buyer = parts[0];
      const seller = parts[1] || parts[0];
      const msgCount = await Message.countDocuments({ conversation: c._id });
      return {
        id: c._id.toString(),
        listing: c.listingTitle || "Conversation",
        buyer: buyer?.name || buyer?.email || "User A",
        seller: seller?.name || seller?.email || "User B",
        buyerAvatar: initials(buyer?.name || "", buyer?.email),
        sellerAvatar: initials(seller?.name || "", seller?.email),
        lastMessage: c.lastMessageText || "—",
        messages: msgCount,
        updated: relativeTime((c.lastMessageAt as Date) || (c.updatedAt as Date)),
        flagged: false,
      };
    }),
  );

  return {
    items,
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

export async function getAdminConversationMessages(id: string) {
  const { Conversation } = await import("../chat/conversation.model.js");
  const { Message } = await import("../chat/message.model.js");
  if (!mongoose.isValidObjectId(id)) throw new AppError(400, "Invalid id", "VALIDATION_ERROR");
  const convo = await Conversation.findById(id)
    .populate("participants", "name email avatar")
    .lean();
  if (!convo) throw new AppError(404, "Conversation not found", "NOT_FOUND");
  const messages = await Message.find({ conversation: id })
    .sort({ createdAt: 1 })
    .limit(100)
    .populate("sender", "name email")
    .lean();
  return {
    conversation: {
      id: convo._id.toString(),
      listing: convo.listingTitle || "Conversation",
    },
    messages: messages.map((m) => {
      const sender = m.sender as { name?: string; email?: string } | null;
      return {
        id: m._id.toString(),
        text: m.text || "",
        sender: sender?.name || sender?.email || "User",
        createdAt: relativeTime(m.createdAt as Date | undefined),
      };
    }),
  };
}
