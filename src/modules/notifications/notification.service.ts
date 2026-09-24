import mongoose from "mongoose";
import { Notification, NOTIFICATION_TYPES } from "./notification.model.js";
import { AppError } from "../../utils/AppError.js";
import { z } from "zod";
import { decryptChatText } from "../chat/chat.crypto.js";

function formatTime(date: Date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function maybePersistDecrypted(
  doc: InstanceType<typeof Notification>,
  title: string,
  body: string,
) {
  const rawTitle = String(doc.title || "");
  const rawBody = String(doc.body || "");
  if (!rawTitle.startsWith("enc:") && !rawBody.startsWith("enc:")) return;
  doc.title = title;
  doc.body = body;
  void doc.save().catch(() => undefined);
}

export function serializeNotification(doc: InstanceType<typeof Notification>) {
  const createdAt =
    (doc as InstanceType<typeof Notification> & { createdAt?: Date })
      .createdAt || new Date();
  const title = decryptChatText(doc.title);
  const body = decryptChatText(doc.body);
  maybePersistDecrypted(doc, title, body);
  return {
    id: doc._id.toString(),
    type: doc.type,
    title,
    body,
    time: formatTime(createdAt),
    read: doc.read,
    href: doc.href || undefined,
    image: doc.image || undefined,
    createdAt,
  };
}

export async function createNotification(input: {
  userId: string;
  type: (typeof NOTIFICATION_TYPES)[number];
  title: string;
  body: string;
  href?: string;
  image?: string;
}) {
  const doc = await Notification.create({
    user: input.userId,
    type: input.type,
    title: input.title,
    body: input.body,
    href: input.href || "",
    image: input.image || "",
    read: false,
  });

  // Best-effort device push (web/mobile tokens registered via /me/devices)
  try {
    const { User } = await import("../users/user.model.js");
    const { sendFcmToTokens } = await import("./fcm.service.js");
    const user = await User.findById(input.userId).select("devices");
    const tokens = (user?.devices || [])
      .map((d) => (d as { pushToken?: string }).pushToken)
      .filter((t): t is string => Boolean(t));
    if (tokens.length) {
      void sendFcmToTokens(tokens, {
        title: input.title,
        body: input.body,
        data: { type: input.type, href: input.href || "" },
      });
    }
  } catch {
    /* push is optional */
  }

  return serializeNotification(doc);
}

export async function listNotifications(userId: string) {
  const rows = await Notification.find({ user: userId })
    .sort({ createdAt: -1 })
    .limit(100);
  return rows.map(serializeNotification);
}

export async function unreadCount(userId: string) {
  return Notification.countDocuments({ user: userId, read: false });
}

export async function markRead(userId: string, id: string) {
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(404, "Notification not found", "NOT_FOUND");
  }
  const doc = await Notification.findOneAndUpdate(
    { _id: id, user: userId },
    { read: true },
    { new: true },
  );
  if (!doc) throw new AppError(404, "Notification not found", "NOT_FOUND");
  return serializeNotification(doc);
}

export async function markAllRead(userId: string) {
  await Notification.updateMany({ user: userId, read: false }, { read: true });
  return { ok: true };
}

export async function deleteNotification(userId: string, id: string) {
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(404, "Notification not found", "NOT_FOUND");
  }
  const res = await Notification.deleteOne({ _id: id, user: userId });
  if (!res.deletedCount) {
    throw new AppError(404, "Notification not found", "NOT_FOUND");
  }
  return { id };
}

export async function clearAllNotifications(userId: string) {
  const res = await Notification.deleteMany({ user: userId });
  return { ok: true as const, deleted: res.deletedCount || 0 };
}

export const createNotificationSchema = z.object({
  type: z.enum(NOTIFICATION_TYPES),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(1000),
  href: z.string().optional(),
  image: z.string().optional(),
  userId: z.string().optional(),
});
