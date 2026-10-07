import mongoose from "mongoose";
import { z } from "zod";
import { AppError } from "../../utils/AppError.js";
import { User } from "../users/user.model.js";
import { Listing } from "../listings/listing.model.js";
import { Conversation } from "../chat/conversation.model.js";
import { SellerReview } from "../reviews/sellerReview.model.js";
import { ModerationReport } from "../admin/moderationReport.model.js";
import { createNotification } from "../notifications/notification.service.js";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { getIo } from "../chat/socket.js";
import { renderNoticeEmail } from "../mail/brandedEmail.js";

async function sendReportEmail(to: string[], subject: string, text: string) {
  const recipients = [...new Set(to.map((email) => email.trim()).filter(Boolean))];
  if (!recipients.length || !env.RESEND_API_KEY || !env.EMAIL_FROM) return;
  const title = subject.replace(/^\[Listifys\]\s*/, "");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: recipients,
      subject,
      text,
      html: renderNoticeEmail({ title, text }),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    logger.warn("Report email failed", { status: res.status, detail: detail.slice(0, 200) });
    return;
  }
  logger.info("Report email accepted", { subject, recipients: recipients.length });
}

/**
 * Tell the reported seller (about their listing or their profile). The reporter stays anonymous,
 * and they hear about each target at most once a day however many people report it.
 */
async function notifyReportedParty(input: {
  recipientId: string;
  target: "listing" | "profile";
  /** Reports on the same target in the last day, including this one. */
  recentFilter: Record<string, unknown>;
  listingTitle?: string;
  reason: string;
  href: string;
}) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await ModerationReport.countDocuments({
    ...input.recentFilter,
    source: "user_report",
    createdAt: { $gte: since },
  });
  if (recent > 1) return;

  const title =
    input.target === "listing" ? "Your listing was reported" : "Your profile was reported";
  const body =
    input.target === "listing"
      ? `Your listing “${input.listingTitle || "Listing"}” was reported for “${input.reason}”. Our team will review it — it stays live unless it breaks our policies. You can edit it from My Listings if anything needs fixing.`
      : `Someone reported your profile for “${input.reason}”. Our team will review it — your account stays active unless it breaks our policies.`;

  try {
    await createNotification({
      userId: input.recipientId,
      type: input.target === "listing" ? "listing" : "system",
      title,
      body,
      href: input.href,
    });
    getIo()?.to(`user:${input.recipientId}`).emit("notification:new", { title, body });
  } catch (err) {
    logger.warn("Failed to notify reported user", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const recipient = await User.findById(input.recipientId).select("email isActive");
    if (recipient?.email && recipient.isActive !== false) {
      await sendReportEmail([recipient.email], `[Listifys] ${title}`, body);
    }
  } catch (err) {
    logger.warn("Failed to email reported user", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Confirm the report to the person who filed it. Moderators work from the admin panel queue. */
async function notifyReportSubmitted(input: {
  reportId: string;
  subject: string;
  reason: string;
  reporterId: string;
  reporterEmail?: string;
  /** Page of the reported listing, profile, or chat. */
  targetHref: string;
}) {
  const body = `Thanks — we received your report on “${input.subject}” (${input.reason}). Our team will review it.`;
  const title = "Report received";

  try {
    await createNotification({
      userId: input.reporterId,
      type: "system",
      title,
      body,
      href: input.targetHref,
    });
    getIo()?.to(`user:${input.reporterId}`).emit("notification:new", { title, body });
  } catch (err) {
    logger.warn("Failed to notify reporter about report", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (input.reporterEmail) {
    try {
      await sendReportEmail(
        [input.reporterEmail],
        `[Listifys] ${title}`,
        [body, "", `Report ID: ${input.reportId}`].join("\n"),
      );
    } catch (err) {
      logger.warn("Failed to email reporter about report", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export const createUserReportSchema = z.object({
  type: z.enum(["listing", "user", "image", "chat", "review"]),
  targetId: z.string().min(1),
  reason: z.string().min(3).max(500),
  imageUrl: z.string().optional(),
  details: z.string().trim().max(1000).optional(),
});

function priorityFromReason(reason: string): "high" | "medium" | "low" {
  const r = reason.toLowerCase();
  if (/scam|fraud|harass|threat|illegal|child|weapon|counterfeit|spam|abuse/.test(r)) {
    return "high";
  }
  if (/misleading|fake|inappropriate|offensive|wrong/.test(r)) {
    return "medium";
  }
  return "medium";
}

/** A reporter's report on a target stays "already reported" until moderators close it. */
function findOpenReport(
  reporterId: string,
  type: z.infer<typeof createUserReportSchema>["type"],
  targetId: string,
) {
  return ModerationReport.findOne({
    type,
    subjectId: new mongoose.Types.ObjectId(targetId),
    reporterId: new mongoose.Types.ObjectId(reporterId),
    status: { $in: ["open", "reviewing"] },
  });
}

export const reportStatusQuerySchema = z.object({
  type: createUserReportSchema.shape.type,
  targetId: z.string().min(1),
});

export async function getUserReportStatus(
  reporterId: string,
  query: z.infer<typeof reportStatusQuerySchema>,
) {
  if (!mongoose.isValidObjectId(query.targetId)) return { reported: false };
  const existing = await findOpenReport(reporterId, query.type, query.targetId);
  return { reported: Boolean(existing) };
}

export async function createUserReport(
  reporterId: string,
  input: z.infer<typeof createUserReportSchema>,
) {
  if (!mongoose.isValidObjectId(input.targetId)) {
    throw new AppError(400, "Invalid target", "VALIDATION_ERROR");
  }

  const reporter = await User.findById(reporterId).select("name email");
  if (!reporter) throw new AppError(401, "Authentication required", "UNAUTHORIZED");

  const reporterName = reporter.name || reporter.email || "User";
  let subject = "";
  let listingId: mongoose.Types.ObjectId | undefined;
  let userId: mongoose.Types.ObjectId | undefined;
  let conversationId: mongoose.Types.ObjectId | undefined;
  let reviewId: mongoose.Types.ObjectId | undefined;
  let imageUrl = input.imageUrl || "";
  let targetHref = "/notifications";
  const type = input.type;

  if (input.type === "listing" || input.type === "image") {
    const listing = await Listing.findById(input.targetId).select(
      "title seller images status slug",
    );
    if (!listing) throw new AppError(404, "Listing not found", "NOT_FOUND");
    if (String(listing.seller) === String(reporterId)) {
      throw new AppError(400, "You cannot report your own listing", "VALIDATION_ERROR");
    }
    subject = listing.title || "Listing";
    listingId = listing._id;
    userId = listing.seller as mongoose.Types.ObjectId;
    targetHref = `/listing/${listing.slug || listing._id.toString()}`;
    if (input.type === "image") {
      imageUrl =
        imageUrl ||
        (Array.isArray(listing.images) && listing.images[0] ? String(listing.images[0]) : "");
    }
  } else if (input.type === "user") {
    const user = await User.findById(input.targetId).select("name email slug");
    if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
    if (String(user._id) === String(reporterId)) {
      throw new AppError(400, "You cannot report yourself", "VALIDATION_ERROR");
    }
    subject = user.name || user.email || "User";
    userId = user._id;
    targetHref = `/sellerprofile/${user.slug || user._id.toString()}`;
  } else if (input.type === "chat") {
    const convo = await Conversation.findById(input.targetId).select(
      "listingTitle participants listingId",
    );
    if (!convo) throw new AppError(404, "Conversation not found", "NOT_FOUND");
    const partIds = (convo.participants || []).map((p) => String(p));
    if (!partIds.includes(String(reporterId))) {
      throw new AppError(403, "Not a participant", "FORBIDDEN");
    }
    subject = convo.listingTitle || "Conversation";
    conversationId = convo._id;
    targetHref = `/messages?c=${convo._id.toString()}`;
    if (convo.listingId) listingId = convo.listingId as mongoose.Types.ObjectId;
  } else if (input.type === "review") {
    const review = await SellerReview.findById(input.targetId)
      .populate("reviewer", "name email")
      .populate("seller", "name email slug");
    if (!review) throw new AppError(404, "Review not found", "NOT_FOUND");
    if (String(review.reviewer) === String(reporterId)) {
      throw new AppError(400, "You cannot report your own review", "VALIDATION_ERROR");
    }
    const reviewer = review.reviewer as { name?: string; email?: string } | null;
    subject = `Review by ${reviewer?.name || reviewer?.email || "user"}`;
    reviewId = review._id;
    const sellerRaw = review.seller as unknown;
    let sellerSlug = "";
    if (sellerRaw && typeof sellerRaw === "object" && "_id" in (sellerRaw as object)) {
      userId = (sellerRaw as { _id: mongoose.Types.ObjectId })._id;
      sellerSlug = (sellerRaw as { slug?: string }).slug || "";
    } else if (sellerRaw) {
      userId = sellerRaw as mongoose.Types.ObjectId;
    }
    if (userId) targetHref = `/sellerprofile/${sellerSlug || userId.toString()}?tab=reviews`;
    if (review.listing) listingId = review.listing as mongoose.Types.ObjectId;
    // Mark review flagged so it surfaces in admin reviews too
    if (review.status === "published") {
      review.status = "flagged";
      await review.save();
    }
  }

  const existing = await findOpenReport(reporterId, type, input.targetId);
  if (existing) {
    return {
      id: existing._id.toString(),
      status: existing.status,
      duplicate: true,
    };
  }

  const doc = await ModerationReport.create({
    type,
    subject,
    subjectId: new mongoose.Types.ObjectId(input.targetId),
    listingId,
    userId,
    conversationId,
    reviewId,
    imageUrl,
    reporterId: reporter._id,
    reporterName,
    reason: input.reason.trim(),
    details: input.details || "",
    status: "open",
    priority: priorityFromReason(input.reason),
    source: "user_report",
  });

  await notifyReportSubmitted({
    reportId: doc._id.toString(),
    subject,
    reason: input.reason.trim(),
    reporterId,
    reporterEmail: reporter.email || undefined,
    targetHref,
  });

  if ((type === "listing" || type === "image") && listingId && userId) {
    await notifyReportedParty({
      recipientId: userId.toString(),
      target: "listing",
      recentFilter: { listingId, type: { $in: ["listing", "image"] } },
      listingTitle: subject,
      reason: input.reason.trim(),
      href: targetHref,
    });
  } else if (type === "user" && userId) {
    await notifyReportedParty({
      recipientId: userId.toString(),
      target: "profile",
      recentFilter: { userId, type: "user" },
      reason: input.reason.trim(),
      href: targetHref,
    });
  }

  return { id: doc._id.toString(), status: doc.status, duplicate: false };
}

/** Ensure flagged seller reviews appear as open moderation cases. */
export async function syncFlaggedReviewsToModeration() {
  const flagged = await SellerReview.find({ status: "flagged" })
    .populate("reviewer", "name email")
    .limit(200)
    .lean();

  for (const review of flagged) {
    const open = await ModerationReport.findOne({
      type: "review",
      reviewId: review._id,
      status: { $in: ["open", "reviewing"] },
    });
    if (open) continue;
    const reviewer = review.reviewer as { name?: string; email?: string } | null;
    await ModerationReport.create({
      type: "review",
      subject: `Review by ${reviewer?.name || reviewer?.email || "user"}`,
      subjectId: review._id,
      reviewId: review._id,
      listingId: review.listing || undefined,
      userId: review.seller,
      reporterName: "System",
      reason: review.comment?.slice(0, 200) || "Flagged seller review",
      status: "open",
      priority: "medium",
      source: "sync",
    });
  }
}

export async function createAdminFlagReport(input: {
  type: "listing" | "user" | "image" | "chat" | "review";
  subject: string;
  subjectId: string;
  reason: string;
  adminEmail?: string;
  listingId?: string;
  userId?: string;
  reviewId?: string;
  conversationId?: string;
  imageUrl?: string;
}) {
  const open = await ModerationReport.findOne({
    type: input.type,
    subjectId: new mongoose.Types.ObjectId(input.subjectId),
    status: { $in: ["open", "reviewing"] },
  });
  if (open) return open;

  return ModerationReport.create({
    type: input.type,
    subject: input.subject,
    subjectId: new mongoose.Types.ObjectId(input.subjectId),
    listingId: input.listingId ? new mongoose.Types.ObjectId(input.listingId) : undefined,
    userId: input.userId ? new mongoose.Types.ObjectId(input.userId) : undefined,
    reviewId: input.reviewId ? new mongoose.Types.ObjectId(input.reviewId) : undefined,
    conversationId: input.conversationId
      ? new mongoose.Types.ObjectId(input.conversationId)
      : undefined,
    imageUrl: input.imageUrl || "",
    reporterName: input.adminEmail || "Admin",
    reason: input.reason,
    status: "open",
    priority: priorityFromReason(input.reason),
    source: "admin_flag",
  });
}
