import argon2 from "argon2";
import mongoose from "mongoose";
import type { Request } from "express";
import { z } from "zod";
import { getAdminEmails } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import { User } from "../users/user.model.js";
import { Listing } from "../listings/listing.model.js";
import { Payment } from "../payments/payment.model.js";
import { Message } from "../chat/message.model.js";
import { ListingOffer } from "../offers/listingOffer.model.js";
import { AdminAccount } from "./adminAccount.model.js";
import { AdminActivity } from "./adminActivity.model.js";
import { AppUpdateConfig } from "./appUpdateConfig.model.js";
import { ModerationReport } from "./moderationReport.model.js";
import { NotificationCampaign } from "./notificationCampaign.model.js";
import { PlatformSettings } from "./platformSettings.model.js";
import { syncFlaggedReviewsToModeration } from "./report.service.js";
import { logAdminActivity } from "./adminActivity.util.js";

export const pageQuerySchema = z.object({
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().optional().default("all"),
});

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

function initials(name: string, email?: string | null) {
  const base = (name || email || "?").trim();
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
  }
  return base.slice(0, 2).toUpperCase();
}

function maskIp(ip?: string) {
  if (!ip) return "—";
  const parts = ip.replace("::ffff:", "").split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.•••.${parts[3]}`;
  return ip.slice(0, 8) + "•••";
}

export async function syncAdminAccountsFromEnv() {
  const emails = getAdminEmails();
  for (const email of emails) {
    await AdminAccount.updateOne(
      { email },
      { $setOnInsert: { email, role: "super", isActive: true } },
      { upsert: true },
    );
  }
}

export async function touchAdminLogin(email: string) {
  await syncAdminAccountsFromEnv();
  await AdminAccount.updateOne(
    { email: email.toLowerCase() },
    { $set: { lastLoginAt: new Date() } },
  );
}

export async function countOpenModerationReports() {
  return ModerationReport.countDocuments({
    status: { $in: ["open", "reviewing"] },
  });
}

export async function getAdminAnalytics() {
  const since30 = new Date(Date.now() - 30 * 86400000);
  const [
    totalUsers,
    activeListings,
    monetizationAgg,
    openReports,
    categoryCounts,
    signupAgg,
    chats,
    offers,
    savedAgg,
    boosts30,
  ] = await Promise.all([
    User.countDocuments({}),
    Listing.countDocuments({ status: "active" }),
    Payment.aggregate([
      { $match: { status: "succeeded", createdAt: { $gte: since30 } } },
      { $group: { _id: null, total: { $sum: "$totalMinor" } } },
    ]),
    countOpenModerationReports(),
    Listing.aggregate([
      { $match: { status: { $ne: "removed" } } },
      { $group: { _id: "$category", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    User.aggregate([
      { $unwind: "$providers" },
      { $group: { _id: "$providers.provider", count: { $sum: 1 } } },
    ]),
    Message.countDocuments({ createdAt: { $gte: since30 } }),
    ListingOffer.countDocuments({ createdAt: { $gte: since30 } }).catch(() => 0),
    User.aggregate([
      { $project: { saved: { $size: { $ifNull: ["$savedListingIds", []] } } } },
      { $group: { _id: null, total: { $sum: "$saved" } } },
    ]),
    Payment.countDocuments({
      purpose: "boost",
      status: "succeeded",
      createdAt: { $gte: since30 },
    }),
  ]);

  const monetizationMinor = monetizationAgg[0]?.total || 0;
  const providerMap: Record<string, number> = {};
  for (const row of signupAgg) {
    providerMap[String(row._id)] = row.count;
  }
  const signupTotal =
    (providerMap.email || 0) +
      (providerMap.google || 0) +
      (providerMap.apple || 0) +
      (providerMap.phone || 0) || 1;
  const pct = (n: number) => Math.round((n / signupTotal) * 100);

  return {
    totalUsers,
    activeListings,
    monetization30d:
      monetizationMinor > 0
        ? `₹${(monetizationMinor / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`
        : "₹0",
    openReports,
    categoryCounts: categoryCounts.map((c) => ({
      name: String(c._id),
      value: c.count,
    })),
    signupMethods: [
      { name: "Email", value: pct(providerMap.email || 0), color: "#2563eb" },
      { name: "Google", value: pct(providerMap.google || 0), color: "#16a34a" },
      { name: "Apple", value: pct(providerMap.apple || 0), color: "#64748b" },
      { name: "Phone", value: pct(providerMap.phone || 0), color: "#7c3aed" },
    ],
    engagementBars: [
      { label: "Chats (30d)", value: chats },
      { label: "Offers (30d)", value: offers },
      { label: "Saved listings", value: savedAgg[0]?.total || 0 },
      { label: "Boost purchases (30d)", value: boosts30 },
    ],
  };
}

export async function getModerationStats() {
  await syncFlaggedReviewsToModeration().catch(() => undefined);
  const since30 = new Date(Date.now() - 30 * 86400000);
  const [open, listing, image, review, resolved30] = await Promise.all([
    ModerationReport.countDocuments({ status: { $in: ["open", "reviewing"] } }),
    ModerationReport.countDocuments({ type: "listing", status: { $in: ["open", "reviewing"] } }),
    ModerationReport.countDocuments({ type: "image", status: { $in: ["open", "reviewing"] } }),
    ModerationReport.countDocuments({ type: "review", status: { $in: ["open", "reviewing"] } }),
    ModerationReport.countDocuments({ status: "resolved", updatedAt: { $gte: since30 } }),
  ]);
  return { open, listing, image, review, resolved30 };
}

export const moderationQuerySchema = pageQuerySchema.extend({
  type: z.string().optional().default("all"),
  priority: z.string().optional().default("all"),
});

export async function listModerationReports(query: z.infer<typeof moderationQuerySchema>) {
  await syncFlaggedReviewsToModeration().catch(() => undefined);
  const filter: Record<string, unknown> = {};
  if (query.status && query.status !== "all") {
    const map: Record<string, string> = {
      Open: "open",
      Reviewing: "reviewing",
      Resolved: "resolved",
      Dismissed: "dismissed",
    };
    filter.status = map[query.status] || query.status.toLowerCase();
  }
  if (query.type && query.type !== "all") filter.type = query.type.toLowerCase();
  if (query.priority && query.priority !== "all") {
    filter.priority = query.priority.toLowerCase();
  }
  if (query.q?.trim()) {
    const rx = new RegExp(query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ subject: rx }, { reason: rx }, { reporterName: rx }];
  }
  const skip = (query.page - 1) * query.limit;
  const [total, rows] = await Promise.all([
    ModerationReport.countDocuments(filter),
    ModerationReport.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean(),
  ]);
  return {
    items: rows.map((r) => ({
      id: r._id.toString(),
      code: `MR-${r._id.toString().slice(-4).toUpperCase()}`,
      type: r.type,
      subject: r.subject,
      reporter: r.reporterName || "—",
      reason: r.reason,
      listingId: r.listingId ? String(r.listingId) : "",
      userId: r.userId ? String(r.userId) : "",
      reviewId: r.reviewId ? String(r.reviewId) : "",
      conversationId: r.conversationId ? String(r.conversationId) : "",
      status:
        r.status === "open"
          ? "Open"
          : r.status === "reviewing"
            ? "Reviewing"
            : r.status === "resolved"
              ? "Resolved"
              : "Dismissed",
      priority: r.priority === "high" ? "High" : r.priority === "medium" ? "Medium" : "Low",
      created: relativeTime(r.createdAt as Date),
    })),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

export const patchModerationReportSchema = z.object({
  status: z.enum(["open", "reviewing", "resolved", "dismissed"]).optional(),
  notes: z.string().max(2000).optional(),
  /** Optional enforcement when resolving */
  action: z
    .enum(["none", "pause_listing", "remove_listing", "hide_review", "deactivate_user"])
    .optional()
    .default("none"),
});

export async function patchModerationReport(
  req: Request,
  id: string,
  body: z.infer<typeof patchModerationReportSchema>,
) {
  if (!mongoose.isValidObjectId(id)) throw new AppError(400, "Invalid id", "VALIDATION_ERROR");
  const report = await ModerationReport.findById(id);
  if (!report) throw new AppError(404, "Report not found", "NOT_FOUND");
  if (body.status) {
    report.status = body.status;
    if (body.status === "resolved" || body.status === "dismissed") {
      report.resolvedAt = new Date();
      report.resolvedBy = req.adminEmail || "";
    }
  }
  if (body.notes !== undefined) report.notes = body.notes;

  const action = body.action || "none";
  if (action !== "none" && (body.status === "resolved" || !body.status)) {
    if (!body.status) {
      report.status = "resolved";
      report.resolvedAt = new Date();
      report.resolvedBy = req.adminEmail || "";
    }
    if (action === "pause_listing" && report.listingId) {
      const { Listing } = await import("../listings/listing.model.js");
      await Listing.findByIdAndUpdate(report.listingId, { status: "paused" });
    }
    if (action === "remove_listing" && report.listingId) {
      const { Listing } = await import("../listings/listing.model.js");
      await Listing.findByIdAndUpdate(report.listingId, { status: "removed" });
    }
    if (action === "hide_review" && report.reviewId) {
      const { SellerReview } = await import("../reviews/sellerReview.model.js");
      await SellerReview.findByIdAndUpdate(report.reviewId, { status: "hidden" });
    }
    if (action === "deactivate_user" && report.userId) {
      const { User } = await import("../users/user.model.js");
      await User.findByIdAndUpdate(report.userId, { isActive: false });
    }
  }

  await report.save();
  await logAdminActivity(req, {
    action: `Updated report → ${report.status}${action !== "none" ? ` (${action})` : ""}`,
    target: `${report.subject} · ${report.reason}`,
    section: "Moderation",
  });
  return { id: report._id.toString(), status: report.status, action };
}

export async function getActivityStats() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const since30 = new Date(Date.now() - 30 * 86400000);
  const [today, activeAdmins, moderationActions, sensitive] = await Promise.all([
    AdminActivity.countDocuments({ createdAt: { $gte: startOfDay } }),
    AdminAccount.countDocuments({ isActive: true }),
    AdminActivity.countDocuments({
      section: "Moderation",
      createdAt: { $gte: since30 },
    }),
    AdminActivity.countDocuments({
      action: { $regex: /deactivat|removed|refund|force|delete/i },
      createdAt: { $gte: since30 },
    }),
  ]);
  return { today, activeAdmins, moderationActions, sensitive };
}

export const activityQuerySchema = pageQuerySchema.extend({
  admin: z.string().optional().default("all"),
  section: z.string().optional().default("all"),
});

export async function listAdminActivity(query: z.infer<typeof activityQuerySchema>) {
  const filter: Record<string, unknown> = {};
  if (query.section && query.section !== "all") filter.section = query.section;
  if (query.admin && query.admin !== "all") filter.adminEmail = query.admin.toLowerCase();
  if (query.q?.trim()) {
    const rx = new RegExp(query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ action: rx }, { target: rx }, { adminName: rx }, { adminEmail: rx }];
  }
  const skip = (query.page - 1) * query.limit;
  const [total, rows, admins] = await Promise.all([
    AdminActivity.countDocuments(filter),
    AdminActivity.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean(),
    AdminAccount.find({ isActive: true }).select("email").lean(),
  ]);
  return {
    items: rows.map((a) => ({
      id: a._id.toString(),
      admin: a.adminName || a.adminEmail,
      avatar: initials(a.adminName || "", a.adminEmail),
      action: a.action,
      target: a.target || "—",
      section: a.section || "General",
      ip: maskIp(a.ip),
      time: relativeTime(a.createdAt as Date),
    })),
    admins: admins.map((a) => a.email),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

export async function getNotificationCampaignStats() {
  const since30 = new Date(Date.now() - 30 * 86400000);
  const [sent30, scheduled, agg] = await Promise.all([
    NotificationCampaign.countDocuments({ status: "sent", sentAt: { $gte: since30 } }),
    NotificationCampaign.countDocuments({ status: "scheduled" }),
    NotificationCampaign.aggregate([
      { $match: { status: "sent", sentAt: { $gte: since30 } } },
      {
        $group: {
          _id: null,
          recipients: { $sum: "$recipientCount" },
          opens: { $sum: "$openCount" },
        },
      },
    ]),
  ]);
  const recipients = agg[0]?.recipients || 0;
  const opens = agg[0]?.opens || 0;
  const openRate = recipients > 0 ? `${Math.round((opens / recipients) * 100)}%` : "—";
  return {
    sent30,
    reach: recipients > 0 ? recipients.toLocaleString() : "0",
    openRate,
    scheduled,
  };
}

export const campaignQuerySchema = pageQuerySchema.extend({
  channel: z.string().optional().default("all"),
});

export async function listNotificationCampaigns(query: z.infer<typeof campaignQuerySchema>) {
  const filter: Record<string, unknown> = {};
  if (query.status && query.status !== "all") {
    const map: Record<string, string> = {
      Draft: "draft",
      Scheduled: "scheduled",
      Sent: "sent",
    };
    filter.status = map[query.status] || query.status.toLowerCase();
  }
  if (query.channel && query.channel !== "all") {
    const map: Record<string, string> = {
      "Push + In-app": "push_inapp",
      "Push only": "push",
      "In-app only": "inapp",
    };
    filter.channel = map[query.channel] || query.channel;
  }
  if (query.q?.trim()) {
    const rx = new RegExp(query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ title: rx }, { body: rx }];
  }
  const skip = (query.page - 1) * query.limit;
  const [total, rows] = await Promise.all([
    NotificationCampaign.countDocuments(filter),
    NotificationCampaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean(),
  ]);
  const audienceLabel = (a: string) => {
    if (a === "all") return "All users";
    if (a === "premium") return "Premium sellers";
    return `Market: ${a}`;
  };
  const channelLabel = (c: string) => {
    if (c === "push_inapp") return "Push + In-app";
    if (c === "push") return "Push only";
    return "In-app only";
  };
  return {
    items: rows.map((c) => ({
      id: c._id.toString(),
      title: c.title,
      body: c.body,
      audience: audienceLabel(c.audience),
      channel: channelLabel(c.channel),
      status: c.status === "sent" ? "Sent" : c.status === "scheduled" ? "Scheduled" : "Draft",
      sentAt: c.sentAt
        ? formatDate(c.sentAt) +
          ", " +
          c.sentAt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
        : "—",
      opens: c.recipientCount > 0 ? `${Math.round((c.openCount / c.recipientCount) * 100)}%` : "—",
    })),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

export const createCampaignSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(1000),
  audience: z.enum(["all", "premium", "IN", "US", "CA"]).default("all"),
  channel: z.enum(["push_inapp", "push", "inapp"]).default("push_inapp"),
  status: z.enum(["draft", "scheduled", "sent"]).default("draft"),
  scheduledAt: z.string().datetime().optional(),
});

async function audienceFilter(audience: string) {
  const filter: Record<string, unknown> = { isActive: true };
  if (audience === "premium") filter["sellerPremium.isPremiumSeller"] = true;
  if (audience === "IN" || audience === "US" || audience === "CA") {
    filter.countryCode = audience;
  }
  return filter;
}

async function deliverCampaign(campaign: InstanceType<typeof NotificationCampaign>) {
  const { createNotification } = await import("../notifications/notification.service.js");
  const users = await User.find(await audienceFilter(campaign.audience))
    .select("_id")
    .lean();
  let sent = 0;
  for (const u of users) {
    try {
      if (campaign.channel === "push" || campaign.channel === "push_inapp") {
        await createNotification({
          userId: u._id.toString(),
          type: "promo",
          title: campaign.title,
          body: campaign.body,
        });
      } else {
        await createNotification({
          userId: u._id.toString(),
          type: "system",
          title: campaign.title,
          body: campaign.body,
        });
      }
      sent++;
    } catch {
      /* continue batch */
    }
  }
  campaign.recipientCount = sent;
  campaign.sentAt = new Date();
  campaign.status = "sent";
  await campaign.save();
  return sent;
}

export async function createNotificationCampaign(
  req: Request,
  body: z.infer<typeof createCampaignSchema>,
) {
  const doc = await NotificationCampaign.create({
    title: body.title,
    body: body.body,
    audience: body.audience,
    channel: body.channel,
    status: body.status,
    scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : undefined,
    createdByEmail: req.adminEmail || "",
    createdByName: req.adminName || "",
  });
  if (body.status === "sent") {
    await deliverCampaign(doc);
    await logAdminActivity(req, {
      action: "Sent notification",
      target: body.title,
      section: "App Notifications",
    });
  } else {
    await logAdminActivity(req, {
      action: body.status === "scheduled" ? "Scheduled notification" : "Saved notification draft",
      target: body.title,
      section: "App Notifications",
    });
  }
  return { id: doc._id.toString(), status: doc.status, recipientCount: doc.recipientCount };
}

export async function sendNotificationCampaign(req: Request, id: string) {
  if (!mongoose.isValidObjectId(id)) throw new AppError(400, "Invalid id", "VALIDATION_ERROR");
  const doc = await NotificationCampaign.findById(id);
  if (!doc) throw new AppError(404, "Campaign not found", "NOT_FOUND");
  if (doc.status === "sent") throw new AppError(400, "Already sent", "VALIDATION_ERROR");
  const count = await deliverCampaign(doc);
  await logAdminActivity(req, {
    action: "Sent notification",
    target: doc.title,
    section: "App Notifications",
  });
  return { id: doc._id.toString(), recipientCount: count };
}

export async function getAppUpdateStats() {
  const [active, forceOn, latestAndroid, latestIos] = await Promise.all([
    AppUpdateConfig.countDocuments({ status: "active" }),
    AppUpdateConfig.countDocuments({ status: "active", forceUpdate: true }),
    AppUpdateConfig.findOne({ platform: "android", status: "active" })
      .sort({ publishedAt: -1 })
      .lean(),
    AppUpdateConfig.findOne({ platform: "ios", status: "active" }).sort({ publishedAt: -1 }).lean(),
  ]);
  return {
    active,
    forceOn,
    latestAndroid: latestAndroid?.versionName || "—",
    latestAndroidBuild: latestAndroid?.buildNumber || latestAndroid?.versionCode || "—",
    latestIos: latestIos?.versionName || "—",
    latestIosBuild: latestIos?.buildNumber || latestIos?.versionCode || "—",
  };
}

export async function listAppUpdates() {
  const rows = await AppUpdateConfig.find({}).sort({ updatedAt: -1 }).limit(50).lean();
  const platformLabel = (p: string) => (p === "android" ? "Android" : p === "ios" ? "iOS" : "Both");
  return rows.map((r) => ({
    id: r._id.toString(),
    platform: platformLabel(r.platform),
    versionName: r.versionName,
    versionCode: r.versionCode,
    buildNumber: r.buildNumber || r.versionCode,
    minSupportedVersion: r.minSupportedVersion || "—",
    forceUpdate: r.forceUpdate,
    storeUrl: r.storeUrl,
    releaseNotes: r.releaseNotes,
    status: r.status === "active" ? "Active" : r.status === "deprecated" ? "Deprecated" : "Draft",
    publishedAt: formatDate(r.publishedAt as Date | undefined),
  }));
}

export const upsertAppUpdateSchema = z.object({
  platform: z.enum(["android", "ios", "both"]),
  versionName: z.string().min(1),
  versionCode: z.string().min(1),
  buildNumber: z.string().optional(),
  minSupportedVersion: z.string().optional(),
  forceUpdate: z.boolean().optional(),
  storeUrl: z.string().optional(),
  releaseNotes: z.string().optional(),
  status: z.enum(["draft", "active", "deprecated"]).default("draft"),
});

export async function saveAppUpdate(
  req: Request,
  body: z.infer<typeof upsertAppUpdateSchema>,
  id?: string,
) {
  if (body.status === "active") {
    await AppUpdateConfig.updateMany(
      { platform: body.platform, status: "active", ...(id ? { _id: { $ne: id } } : {}) },
      { $set: { status: "deprecated" } },
    );
  }
  const payload = {
    platform: body.platform,
    versionName: body.versionName,
    versionCode: body.versionCode,
    buildNumber: body.buildNumber || body.versionCode,
    minSupportedVersion: body.minSupportedVersion || "",
    forceUpdate: body.forceUpdate ?? false,
    storeUrl: body.storeUrl || "",
    releaseNotes: body.releaseNotes || "",
    status: body.status,
    publishedAt: body.status === "active" ? new Date() : undefined,
    activatedByEmail: body.status === "active" ? req.adminEmail || "" : "",
  };
  let doc;
  if (id && mongoose.isValidObjectId(id)) {
    doc = await AppUpdateConfig.findByIdAndUpdate(id, payload, { new: true });
    if (!doc) throw new AppError(404, "Config not found", "NOT_FOUND");
  } else {
    doc = await AppUpdateConfig.create(payload);
  }
  await logAdminActivity(req, {
    action: body.status === "active" ? "Activated app update" : "Saved app update",
    target: `${body.platform} ${body.versionName}`,
    section: "App Updates",
  });
  return { id: doc._id.toString(), status: doc.status };
}

export async function listAdminAccounts(query: z.infer<typeof pageQuerySchema>) {
  await syncAdminAccountsFromEnv();
  const filter: Record<string, unknown> = {};
  if (query.status && query.status !== "all") {
    filter.isActive = query.status === "Active" || query.status === "active";
  }
  if (query.q?.trim()) {
    const rx = new RegExp(query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.email = rx;
  }
  const skip = (query.page - 1) * query.limit;
  const [total, accounts] = await Promise.all([
    AdminAccount.countDocuments(filter),
    AdminAccount.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean(),
  ]);
  const emails = accounts.map((a) => a.email);
  const users = await User.find({ email: { $in: emails } }).lean();
  const userMap = new Map(users.map((u) => [u.email?.toLowerCase(), u]));
  const roleLabel = (r: string) =>
    r === "super" ? "Super Admin" : r === "support" ? "Support" : "Moderator";
  return {
    items: accounts.map((a) => {
      const user = userMap.get(a.email);
      return {
        id: a._id.toString(),
        name: user?.name || a.email.split("@")[0] || "Admin",
        email: a.email,
        role: roleLabel(a.role),
        status: a.isActive ? "Active" : "Inactive",
        lastLogin: relativeTime(a.lastLoginAt as Date | undefined),
        avatar: initials(user?.name || "", a.email),
      };
    }),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

export const upsertAdminAccountSchema = z.object({
  email: z.string().email(),
  role: z.enum(["super", "moderator", "support"]).default("moderator"),
  isActive: z.boolean().default(true),
});

export async function upsertAdminAccount(
  req: Request,
  body: z.infer<typeof upsertAdminAccountSchema>,
) {
  const email = body.email.trim().toLowerCase();
  const doc = await AdminAccount.findOneAndUpdate(
    { email },
    {
      email,
      role: body.role,
      isActive: body.isActive,
      addedByEmail: req.adminEmail || "",
    },
    { upsert: true, new: true },
  );
  await logAdminActivity(req, {
    action: "Updated admin account",
    target: email,
    section: "Admins",
  });
  return { id: doc._id.toString(), email: doc.email };
}

export async function getAdminSettings(req: Request) {
  const user = await User.findById(req.userId).select("email name countryCode");
  if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
  let settings = await PlatformSettings.findOne({ key: "default" });
  if (!settings) {
    settings = await PlatformSettings.create({ key: "default" });
  }
  return {
    email: user.email || "",
    name: user.name || "",
    countryCode: user.countryCode || "IN",
    enabledMarkets: settings.enabledMarkets || ["IN", "US", "CA"],
  };
}

export const updatePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

export async function updateAdminPassword(
  req: Request,
  body: z.infer<typeof updatePasswordSchema>,
) {
  const user = await User.findById(req.userId).select("+passwordHash email");
  if (!user?.passwordHash) {
    throw new AppError(400, "No password set on this account", "VALIDATION_ERROR");
  }
  const ok = await argon2.verify(user.passwordHash, body.currentPassword);
  if (!ok) throw new AppError(401, "Current password is incorrect", "INVALID_CREDENTIALS");
  user.passwordHash = await argon2.hash(body.newPassword, { type: argon2.argon2id });
  await user.save();
  await logAdminActivity(req, {
    action: "Changed password",
    target: user.email || "",
    section: "Settings",
  });
  return { ok: true };
}

export const updateMarketsSchema = z.object({
  enabledMarkets: z.array(z.enum(["IN", "US", "CA"])).min(1),
});

export async function updatePlatformMarkets(
  req: Request,
  body: z.infer<typeof updateMarketsSchema>,
) {
  const settings = await PlatformSettings.findOneAndUpdate(
    { key: "default" },
    { enabledMarkets: body.enabledMarkets },
    { upsert: true, new: true },
  );
  await logAdminActivity(req, {
    action: "Updated enabled markets",
    target: body.enabledMarkets.join(", "),
    section: "Settings",
  });
  return { enabledMarkets: settings.enabledMarkets };
}

/** Public mobile endpoint data */
export async function getActiveAppUpdates() {
  const rows = await AppUpdateConfig.find({ status: "active" }).lean();
  return rows.map((r) => ({
    platform: r.platform,
    versionName: r.versionName,
    versionCode: r.versionCode,
    buildNumber: r.buildNumber,
    minSupportedVersion: r.minSupportedVersion,
    forceUpdate: r.forceUpdate,
    storeUrl: r.storeUrl,
    releaseNotes: r.releaseNotes,
  }));
}
