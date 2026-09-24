import mongoose from "mongoose";
import { z } from "zod";
import { AppError } from "../../utils/AppError.js";
import { User } from "../users/user.model.js";
import { Listing } from "../listings/listing.model.js";
import { Conversation } from "../chat/conversation.model.js";
import { SellerReview } from "../reviews/sellerReview.model.js";
import { ModerationReport } from "../admin/moderationReport.model.js";
import { createNotification } from "../notifications/notification.service.js";
import { env, getAdminEmails } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

async function notifyReportSubmitted(input: {
  reportId: string;
  type: string;
  subject: string;
  reason: string;
  reporterName: string;
  reporterId: string;
  duplicate?: boolean;
}) {
  const body = input.duplicate
    ? `Your report on “${input.subject}” was already on file. Our team is still reviewing it.`
    : `Thanks — we received your report on “${input.subject}” (${input.reason}). Our team will review it.`;

  // Confirmation for the reporter
  try {
    await createNotification({
      userId: input.reporterId,
      type: "system",
      title: input.duplicate ? "Report already submitted" : "Report received",
      body,
      href: "/notifications",
    });
  } catch (err) {
    logger.warn("Failed to notify reporter about report", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const adminEmails = getAdminEmails();
  if (!adminEmails.length) return;

  const admins = await User.find({
    email: { $in: adminEmails },
    isActive: { $ne: false },
  }).select("_id email");

  const adminBody = `${input.reporterName} reported ${input.type} “${input.subject}”: ${input.reason}`;
  for (const admin of admins) {
    try {
      await createNotification({
        userId: admin._id.toString(),
        type: "system",
        title: input.duplicate ? "Duplicate user report" : "New user report",
        body: adminBody,
        href: "/admin/moderation",
      });
    } catch {
      /* best-effort */
    }
  }

  if (!env.RESEND_API_KEY || !env.EMAIL_FROM || input.duplicate) return;

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: adminEmails,
        subject: `[Listifys] New ${input.type} report: ${input.subject}`,
        text: [
          `Report ID: ${input.reportId}`,
          `Type: ${input.type}`,
          `Subject: ${input.subject}`,
          `Reason: ${input.reason}`,
          `Reporter: ${input.reporterName}`,
          "",
          `Open moderation: ${env.CLIENT_URL}/admin/moderation`,
        ].join("\n"),
      }),
    });
  } catch (err) {
    logger.warn("Failed to email admins about report", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export const createUserReportSchema = z.object({
  type: z.enum(["listing", "user", "image", "chat", "review"]),
  targetId: z.string().min(1),
  reason: z.string().min(3).max(500),
  imageUrl: z.string().optional(),
  notes: z.string().max(2000).optional(),
});

function priorityFromReason(reason: string): "high" | "medium" | "low" {
  const r = reason.toLowerCase();
  if (
    /scam|fraud|harass|threat|illegal|child|weapon|counterfeit|spam|abuse/.test(
      r,
    )
  ) {
    return "high";
  }
  if (/misleading|fake|inappropriate|offensive|wrong/.test(r)) {
    return "medium";
  }
  return "medium";
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
  let type = input.type;

  if (input.type === "listing" || input.type === "image") {
    const listing = await Listing.findById(input.targetId).select(
      "title seller images status",
    );
    if (!listing) throw new AppError(404, "Listing not found", "NOT_FOUND");
    if (String(listing.seller) === String(reporterId)) {
      throw new AppError(400, "You cannot report your own listing", "VALIDATION_ERROR");
    }
    subject = listing.title || "Listing";
    listingId = listing._id;
    userId = listing.seller as mongoose.Types.ObjectId;
    if (input.type === "image") {
      imageUrl =
        imageUrl ||
        (Array.isArray(listing.images) && listing.images[0]
          ? String(listing.images[0])
          : "");
    }
  } else if (input.type === "user") {
    const user = await User.findById(input.targetId).select("name email");
    if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
    if (String(user._id) === String(reporterId)) {
      throw new AppError(400, "You cannot report yourself", "VALIDATION_ERROR");
    }
    subject = user.name || user.email || "User";
    userId = user._id;
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
    if (convo.listingId) listingId = convo.listingId as mongoose.Types.ObjectId;
  } else if (input.type === "review") {
    const review = await SellerReview.findById(input.targetId)
      .populate("reviewer", "name email")
      .populate("seller", "name email");
    if (!review) throw new AppError(404, "Review not found", "NOT_FOUND");
    if (String(review.reviewer) === String(reporterId)) {
      throw new AppError(400, "You cannot report your own review", "VALIDATION_ERROR");
    }
    const reviewer = review.reviewer as { name?: string; email?: string } | null;
    subject = `Review by ${reviewer?.name || reviewer?.email || "user"}`;
    reviewId = review._id;
    const sellerRaw = review.seller as unknown;
    if (sellerRaw && typeof sellerRaw === "object" && "_id" in (sellerRaw as object)) {
      userId = (sellerRaw as { _id: mongoose.Types.ObjectId })._id;
    } else if (sellerRaw) {
      userId = sellerRaw as mongoose.Types.ObjectId;
    }
    if (review.listing) listingId = review.listing as mongoose.Types.ObjectId;
    // Mark review flagged so it surfaces in admin reviews too
    if (review.status === "published") {
      review.status = "flagged";
      await review.save();
    }
  }

  // Deduplicate open reports from same reporter on same target within 24h
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const existing = await ModerationReport.findOne({
    type,
    subjectId: new mongoose.Types.ObjectId(input.targetId),
    reporterId: new mongoose.Types.ObjectId(reporterId),
    status: { $in: ["open", "reviewing"] },
    createdAt: { $gte: since },
  });
  if (existing) {
    void notifyReportSubmitted({
      reportId: existing._id.toString(),
      type,
      subject: existing.subject || subject || "Report",
      reason: existing.reason || input.reason.trim(),
      reporterName,
      reporterId,
      duplicate: true,
    });
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
    notes: input.notes || "",
    status: "open",
    priority: priorityFromReason(input.reason),
    source: "user_report",
  });

  void notifyReportSubmitted({
    reportId: doc._id.toString(),
    type,
    subject,
    reason: input.reason.trim(),
    reporterName,
    reporterId,
  });

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
    listingId: input.listingId
      ? new mongoose.Types.ObjectId(input.listingId)
      : undefined,
    userId: input.userId
      ? new mongoose.Types.ObjectId(input.userId)
      : undefined,
    reviewId: input.reviewId
      ? new mongoose.Types.ObjectId(input.reviewId)
      : undefined,
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
