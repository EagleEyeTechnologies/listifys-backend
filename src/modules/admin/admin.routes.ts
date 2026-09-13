import { Router } from "express";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import {
  adminListingsQuerySchema,
  adminUsersQuerySchema,
  getAdminCategoryCounts,
  getAdminConversationMessages,
  getAdminListing,
  getAdminMe,
  getAdminStats,
  listAdminBoosts,
  listAdminConversations,
  listAdminEventBookings,
  listAdminListings,
  listAdminPayments,
  listAdminPremium,
  listAdminReviews,
  listAdminUsers,
  pageQuerySchema,
  patchAdminListing,
  patchAdminListingSchema,
  patchAdminReview,
  patchAdminReviewSchema,
  patchAdminUser,
  patchAdminUserSchema,
  softDeleteAdminListing,
} from "./admin.service.js";
import { z } from "zod";
import {
  createCampaignSchema,
  createNotificationCampaign,
  getActivityStats,
  getAdminAnalytics,
  getAdminSettings,
  getAppUpdateStats,
  getModerationStats,
  getNotificationCampaignStats,
  listAdminAccounts,
  listAdminActivity,
  listAppUpdates,
  listModerationReports,
  listNotificationCampaigns,
  patchModerationReport,
  patchModerationReportSchema,
  saveAppUpdate,
  sendNotificationCampaign,
  updateAdminPassword,
  updateMarketsSchema,
  updatePlatformMarkets,
  updatePasswordSchema,
  upsertAdminAccount,
  upsertAdminAccountSchema,
  upsertAppUpdateSchema,
  pageQuerySchema as platformPageQuerySchema,
} from "./admin.platform.service.js";
import { logAdminActivity } from "./adminActivity.util.js";

export const adminRouter = Router();

adminRouter.use(...requireAdmin);

adminRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    const data = await getAdminMe(req.userId!);
    res.json({ success: true, data });
  }),
);

adminRouter.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    const data = await getAdminStats();
    res.json({ success: true, data });
  }),
);

adminRouter.get(
  "/users",
  asyncHandler(async (req, res) => {
    const parsed = adminUsersQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(
        400,
        "Invalid query",
        "VALIDATION_ERROR",
        parsed.error.flatten(),
      );
    }
    const data = await listAdminUsers(parsed.data);
    res.json({ success: true, data });
  }),
);

adminRouter.patch(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const parsed = patchAdminUserSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        "Invalid payload",
        "VALIDATION_ERROR",
        parsed.error.flatten(),
      );
    }
    const id = String(req.params.id);
    const data = await patchAdminUser(id, parsed.data);
    void logAdminActivity(req, {
      action: data.isActive ? "Activated user" : "Deactivated user",
      target: id,
      section: "Users",
    });
    res.json({ success: true, data });
  }),
);

adminRouter.get(
  "/listings",
  asyncHandler(async (req, res) => {
    const parsed = adminListingsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(
        400,
        "Invalid query",
        "VALIDATION_ERROR",
        parsed.error.flatten(),
      );
    }
    const data = await listAdminListings(parsed.data);
    res.json({ success: true, data });
  }),
);

adminRouter.get(
  "/listings/:id",
  asyncHandler(async (req, res) => {
    const data = await getAdminListing(String(req.params.id));
    res.json({ success: true, data });
  }),
);

adminRouter.patch(
  "/listings/:id",
  asyncHandler(async (req, res) => {
    const parsed = patchAdminListingSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        "Invalid payload",
        "VALIDATION_ERROR",
        parsed.error.flatten(),
      );
    }
    const id = String(req.params.id);
    const data = await patchAdminListing(id, parsed.data);
    res.json({ success: true, data });
  }),
);

adminRouter.delete(
  "/listings/:id",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const data = await softDeleteAdminListing(id);
    res.json({ success: true, data });
  }),
);

adminRouter.get(
  "/categories",
  asyncHandler(async (_req, res) => {
    const data = await getAdminCategoryCounts();
    res.json({ success: true, data });
  }),
);

const paymentsQuerySchema = pageQuerySchema.extend({
  purpose: z.string().optional().default("all"),
  provider: z.string().optional().default("all"),
});

adminRouter.get(
  "/payments",
  asyncHandler(async (req, res) => {
    const parsed = paymentsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "Invalid query", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await listAdminPayments(parsed.data);
    res.json({ success: true, data });
  }),
);

adminRouter.get(
  "/boosts",
  asyncHandler(async (req, res) => {
    const parsed = pageQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "Invalid query", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await listAdminBoosts(parsed.data);
    res.json({ success: true, data });
  }),
);

adminRouter.get(
  "/premium",
  asyncHandler(async (req, res) => {
    const parsed = pageQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "Invalid query", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await listAdminPremium(parsed.data);
    res.json({ success: true, data });
  }),
);

adminRouter.get(
  "/event-bookings",
  asyncHandler(async (req, res) => {
    const parsed = pageQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "Invalid query", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await listAdminEventBookings(parsed.data);
    res.json({ success: true, data });
  }),
);

const reviewsQuerySchema = pageQuerySchema.extend({
  rating: z.string().optional().default("all"),
});

adminRouter.get(
  "/reviews",
  asyncHandler(async (req, res) => {
    const parsed = reviewsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "Invalid query", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await listAdminReviews(parsed.data);
    res.json({ success: true, data });
  }),
);

adminRouter.patch(
  "/reviews/:id",
  asyncHandler(async (req, res) => {
    const parsed = patchAdminReviewSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await patchAdminReview(String(req.params.id), parsed.data);
    res.json({ success: true, data });
  }),
);

adminRouter.get(
  "/conversations",
  asyncHandler(async (req, res) => {
    const parsed = pageQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "Invalid query", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await listAdminConversations(parsed.data);
    res.json({ success: true, data });
  }),
);

adminRouter.get(
  "/conversations/:id/messages",
  asyncHandler(async (req, res) => {
    const data = await getAdminConversationMessages(String(req.params.id));
    res.json({ success: true, data });
  }),
);

adminRouter.get(
  "/analytics",
  asyncHandler(async (_req, res) => {
    const data = await getAdminAnalytics();
    res.json({ success: true, data });
  }),
);

adminRouter.get(
  "/moderation/stats",
  asyncHandler(async (_req, res) => {
    const data = await getModerationStats();
    res.json({ success: true, data });
  }),
);

const moderationQuerySchema = platformPageQuerySchema.extend({
  type: z.string().optional().default("all"),
  priority: z.string().optional().default("all"),
});

adminRouter.get(
  "/moderation",
  asyncHandler(async (req, res) => {
    const parsed = moderationQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "Invalid query", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await listModerationReports(parsed.data);
    res.json({ success: true, data });
  }),
);

adminRouter.patch(
  "/moderation/:id",
  asyncHandler(async (req, res) => {
    const parsed = patchModerationReportSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await patchModerationReport(req, String(req.params.id), parsed.data);
    res.json({ success: true, data });
  }),
);

adminRouter.get(
  "/activity/stats",
  asyncHandler(async (_req, res) => {
    const data = await getActivityStats();
    res.json({ success: true, data });
  }),
);

const activityQuerySchema = platformPageQuerySchema.extend({
  admin: z.string().optional().default("all"),
  section: z.string().optional().default("all"),
});

adminRouter.get(
  "/activity",
  asyncHandler(async (req, res) => {
    const parsed = activityQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "Invalid query", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await listAdminActivity(parsed.data);
    res.json({ success: true, data });
  }),
);

adminRouter.get(
  "/notification-campaigns/stats",
  asyncHandler(async (_req, res) => {
    const data = await getNotificationCampaignStats();
    res.json({ success: true, data });
  }),
);

const campaignQuerySchema = platformPageQuerySchema.extend({
  channel: z.string().optional().default("all"),
});

adminRouter.get(
  "/notification-campaigns",
  asyncHandler(async (req, res) => {
    const parsed = campaignQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "Invalid query", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await listNotificationCampaigns(parsed.data);
    res.json({ success: true, data });
  }),
);

adminRouter.post(
  "/notification-campaigns",
  asyncHandler(async (req, res) => {
    const parsed = createCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await createNotificationCampaign(req, parsed.data);
    res.json({ success: true, data });
  }),
);

adminRouter.post(
  "/notification-campaigns/:id/send",
  asyncHandler(async (req, res) => {
    const data = await sendNotificationCampaign(req, String(req.params.id));
    res.json({ success: true, data });
  }),
);

adminRouter.get(
  "/app-updates/stats",
  asyncHandler(async (_req, res) => {
    const data = await getAppUpdateStats();
    res.json({ success: true, data });
  }),
);

adminRouter.get(
  "/app-updates",
  asyncHandler(async (_req, res) => {
    const data = await listAppUpdates();
    res.json({ success: true, data });
  }),
);

adminRouter.post(
  "/app-updates",
  asyncHandler(async (req, res) => {
    const parsed = upsertAppUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await saveAppUpdate(req, parsed.data);
    res.json({ success: true, data });
  }),
);

adminRouter.patch(
  "/app-updates/:id",
  asyncHandler(async (req, res) => {
    const parsed = upsertAppUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await saveAppUpdate(req, parsed.data, String(req.params.id));
    res.json({ success: true, data });
  }),
);

adminRouter.get(
  "/admins",
  asyncHandler(async (req, res) => {
    const parsed = platformPageQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "Invalid query", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await listAdminAccounts(parsed.data);
    res.json({ success: true, data });
  }),
);

adminRouter.post(
  "/admins",
  asyncHandler(async (req, res) => {
    const parsed = upsertAdminAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await upsertAdminAccount(req, parsed.data);
    res.json({ success: true, data });
  }),
);

adminRouter.get(
  "/settings",
  asyncHandler(async (req, res) => {
    const data = await getAdminSettings(req);
    res.json({ success: true, data });
  }),
);

adminRouter.patch(
  "/settings/password",
  asyncHandler(async (req, res) => {
    const parsed = updatePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await updateAdminPassword(req, parsed.data);
    res.json({ success: true, data });
  }),
);

adminRouter.patch(
  "/settings/markets",
  asyncHandler(async (req, res) => {
    const parsed = updateMarketsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await updatePlatformMarkets(req, parsed.data);
    res.json({ success: true, data });
  }),
);
