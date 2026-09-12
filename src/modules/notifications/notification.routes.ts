import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  deleteNotification,
  listNotifications,
  markAllRead,
  markRead,
  unreadCount,
} from "./notification.service.js";

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

notificationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const [items, unread] = await Promise.all([
      listNotifications(req.userId!),
      unreadCount(req.userId!),
    ]);
    res.json({ success: true, data: { items, unread } });
  }),
);

notificationsRouter.get(
  "/unread-count",
  asyncHandler(async (req, res) => {
    const unread = await unreadCount(req.userId!);
    res.json({ success: true, data: { unread } });
  }),
);

notificationsRouter.post(
  "/:id/read",
  asyncHandler(async (req, res) => {
    const data = await markRead(req.userId!, String(req.params.id));
    res.json({ success: true, data });
  }),
);

notificationsRouter.post(
  "/read-all",
  asyncHandler(async (req, res) => {
    const data = await markAllRead(req.userId!);
    res.json({ success: true, data });
  }),
);

notificationsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const data = await deleteNotification(req.userId!, String(req.params.id));
    res.json({ success: true, data });
  }),
);
