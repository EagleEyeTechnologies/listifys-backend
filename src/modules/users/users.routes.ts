import { Router } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { optionalAuth, requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../utils/AppError.js";
import { User } from "./user.model.js";
import {
  browseListings,
  listMyListings,
  listQuerySchema,
} from "../listings/listing.service.js";
import {
  listConnections,
  removeFollower,
  toMeUser,
  findUserByIdOrSlug,
  getPublicSellerProfile,
  toggleFollow,
  updateMe,
  updateMeSchema,
  changeEmailRequestSchema,
  changeEmailVerifySchema,
  changePhoneRequestSchema,
  changePhoneVerifySchema,
  requestEmailChange,
  verifyEmailChange,
  requestPhoneChange,
  verifyPhoneChange,
  requestAccountDeletion,
  cancelAccountDeletion,
  purgeExpiredAccountDeletions,
} from "./users.service.js";
import { z } from "zod";
import { sendFcmToTokens, fcmReady } from "../notifications/fcm.service.js";

export const usersRouter = Router();

usersRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    void purgeExpiredAccountDeletions(5).catch(() => undefined);
    const user = await User.findById(req.userId);
    if (!user || !user.isActive) {
      throw new AppError(401, "User not found", "UNAUTHORIZED");
    }
    res.json({ success: true, data: toMeUser(user) });
  }),
);

usersRouter.patch(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = updateMeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        "Invalid payload",
        "VALIDATION_ERROR",
        parsed.error.flatten(),
      );
    }
    const data = await updateMe(req.userId!, parsed.data);
    res.json({ success: true, data });
  }),
);

usersRouter.post(
  "/me/delete",
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = await requestAccountDeletion(req.userId!);
    res.json({ success: true, data });
  }),
);

usersRouter.post(
  "/me/delete/cancel",
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = await cancelAccountDeletion(req.userId!);
    res.json({ success: true, data });
  }),
);

usersRouter.post(
  "/me/email/request",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = changeEmailRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid email", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await requestEmailChange(req.userId!, parsed.data.email);
    res.json({ success: true, data });
  }),
);

usersRouter.post(
  "/me/email/verify",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = changeEmailVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await verifyEmailChange(
      req.userId!,
      parsed.data.email,
      parsed.data.code,
    );
    res.json({ success: true, data });
  }),
);

usersRouter.post(
  "/me/phone/request",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = changePhoneRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid phone", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await requestPhoneChange(
      req.userId!,
      parsed.data.phone,
      parsed.data.phoneCode,
    );
    res.json({ success: true, data });
  }),
);

usersRouter.post(
  "/me/phone/verify",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = changePhoneVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await verifyPhoneChange(
      req.userId!,
      parsed.data.phone,
      parsed.data.phoneCode,
      parsed.data.code,
    );
    res.json({ success: true, data });
  }),
);

usersRouter.get(
  "/me/listings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = await listMyListings(req.userId!);
    res.json({ success: true, data });
  }),
);

usersRouter.get(
  "/me/followers",
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = await listConnections(req.userId!, "followers", req.userId);
    res.json({ success: true, data });
  }),
);

usersRouter.get(
  "/me/following",
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = await listConnections(req.userId!, "following", req.userId);
    res.json({ success: true, data });
  }),
);

usersRouter.delete(
  "/me/followers/:userId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = await removeFollower(req.userId!, String(req.params.userId));
    res.json({ success: true, data });
  }),
);

usersRouter.post(
  "/:id/follow",
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = await toggleFollow(req.userId!, String(req.params.id));
    res.json({ success: true, data });
  }),
);

usersRouter.get(
  "/:id/followers",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const data = await listConnections(
      String(req.params.id),
      "followers",
      req.userId,
    );
    res.json({ success: true, data });
  }),
);

usersRouter.get(
  "/:id/following",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const data = await listConnections(
      String(req.params.id),
      "following",
      req.userId,
    );
    res.json({ success: true, data });
  }),
);

usersRouter.post(
  "/me/devices",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        deviceId: z.string().min(8).max(512),
        platform: z.string().min(2).max(40).default("web"),
        pushToken: z.string().min(8).max(512).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const user = await User.findById(req.userId);
    if (!user || !user.isActive) {
      throw new AppError(401, "User not found", "UNAUTHORIZED");
    }
    const devices = Array.isArray(user.devices)
      ? user.devices.map((d) => ({
          deviceId: String((d as { deviceId?: string }).deviceId || ""),
          platform: String((d as { platform?: string }).platform || "web"),
          pushToken: (d as { pushToken?: string }).pushToken
            ? String((d as { pushToken?: string }).pushToken)
            : undefined,
          lastSeenAt: (d as { lastSeenAt?: Date }).lastSeenAt || undefined,
        }))
      : [];
    const idx = devices.findIndex((d) => d.deviceId === parsed.data.deviceId);
    const row: (typeof devices)[number] = {
      deviceId: parsed.data.deviceId,
      platform: parsed.data.platform,
      lastSeenAt: new Date(),
      pushToken: parsed.data.pushToken
        ? parsed.data.pushToken
        : idx >= 0
          ? devices[idx].pushToken
          : undefined,
    };
    if (idx >= 0) devices[idx] = row;
    else devices.push(row);
    user.set("devices", devices);
    await user.save();
    res.json({
      success: true,
      data: { ok: true, fcmReady: fcmReady(), deviceCount: devices.length },
    });
  }),
);

usersRouter.post(
  "/me/devices/test-push",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId);
    if (!user || !user.isActive) {
      throw new AppError(401, "User not found", "UNAUTHORIZED");
    }
    const tokens = (user.devices || [])
      .map((d) => (d as { pushToken?: string }).pushToken)
      .filter((t): t is string => Boolean(t));
    const result = await sendFcmToTokens(tokens, {
      title: "Listifys",
      body: "Notifications are working.",
      data: { type: "test" },
    });
    res.json({ success: true, data: { ...result, fcmReady: fcmReady() } });
  }),
);

usersRouter.get(
  "/:id/listings",
  asyncHandler(async (req, res) => {
    const resolved = await findUserByIdOrSlug(String(req.params.id));
    const id = resolved?._id?.toString() || String(req.params.id);
    if (!mongoose.isValidObjectId(id)) {
      throw new AppError(404, "User not found", "NOT_FOUND");
    }
    // Allow listing browse even if the user document was not migrated.
    const query = listQuerySchema.parse({
      sellerId: id,
      status: "active",
      limit: 50,
      page: 1,
      sort: "latest",
    });
    const data = await browseListings(req.countryCode, query);
    res.json({ success: true, data });
  }),
);

usersRouter.get(
  "/:id",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const data = await getPublicSellerProfile(String(req.params.id), req.userId);
    res.json({ success: true, data });
  }),
);
