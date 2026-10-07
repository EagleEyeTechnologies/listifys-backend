import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { z } from "zod";
import { kv } from "../../redis/client.js";
import { Conversation, makeParticipantKey } from "./conversation.model.js";
import { Message } from "./message.model.js";
import { User } from "../users/user.model.js";
import { Listing } from "../listings/listing.model.js";
import { AppError } from "../../utils/AppError.js";
import { listingHrefFromDoc } from "./listingHref.js";
import { decryptChatText } from "./chat.crypto.js";
import {
  createNotification,
  markMessageNotificationsRead,
} from "../notifications/notification.service.js";
import { isUserOnline, isUserOnlineRedis } from "./presence.js";
import { absolutizeMediaUrl } from "../../utils/mediaUrl.js";
import { getSellerReviewStats } from "../reviews/reviews.service.js";
import { chatListingSwitchMessage, chatOpeningMessage } from "./chatOpeningMessage.js";
import { isEitherBlocked } from "../users/users.service.js";

export const startConversationSchema = z.object({
  recipientId: z.string().min(1),
  listingId: z.string().optional(),
  text: z.string().min(1).max(5000).optional(),
});

const attachmentSchema = z.object({
  url: z.string().min(1).max(2000),
  name: z.string().max(200).optional(),
  mime: z.string().max(120).optional(),
});

export const sendMessageSchema = z
  .object({
    text: z.string().max(5000).optional().default(""),
    attachments: z.array(attachmentSchema).max(4).optional(),
    replyToId: z.string().max(64).optional(),
  })
  .refine((value) => value.text.trim().length > 0 || (value.attachments?.length || 0) > 0, {
    message: "Message is empty",
  });

export const editMessageSchema = z.object({
  text: z.string().min(1).max(5000),
});

/** Inbox date: Today, Yesterday, or a short calendar day. Clients reformat with lastMessageAt. */
function formatListTime(date?: Date | null) {
  if (!date) return "";
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const diffDays = Math.round((todayStart - day) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}

function memberSinceYear(createdAt?: Date | null): string {
  if (!createdAt) return "—";
  return String(createdAt.getFullYear());
}

function yearsOnLabel(createdAt?: Date | null): string {
  if (!createdAt) return "New on Listifys";
  const years = Math.max(
    0,
    Math.floor((Date.now() - createdAt.getTime()) / (365.25 * 24 * 60 * 60 * 1000)),
  );
  if (years < 1) return "Less than 1 year";
  return `${years}+ year${years === 1 ? "" : "s"}`;
}

/** Fix legacy hrefs that still contain raw `&` in service slugs. */
function sanitizeListingHref(href?: string | null) {
  if (!href) return "/browse";
  return href.replace(/\/services\/([^/]+)\//, (_m, slug: string) => {
    const clean =
      slug
        .toLowerCase()
        .replace(/&/g, " ")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "cleaning";
    return `/services/${clean}/`;
  });
}

export function serializeMessage(msg: InstanceType<typeof Message>, viewerId: string) {
  const senderId = msg.sender.toString();
  const mine = senderId === viewerId;
  const createdAt =
    (msg as InstanceType<typeof Message> & { createdAt?: Date }).createdAt || new Date();
  const deleted = Boolean(msg.deletedAt);
  const edited = Boolean(msg.editedAt) && !deleted;
  const readByPeer = (msg.readBy || []).some((id) => id.toString() !== senderId);
  const deliveredToPeer =
    readByPeer || (msg.deliveredTo || []).some((id) => id.toString() !== senderId);
  const attachments = (msg.deletedAt ? [] : msg.attachments || [])
    .map((file) => ({
      url: absolutizeMediaUrl(String(file.url || "")),
      name: String(file.name || ""),
      mime: String(file.mime || ""),
    }))
    .filter((file) => file.url);
  const listingId = msg.listingId?.toString?.() || null;
  const listingTitle = (msg.listingTitle || "").trim();
  const reply = msg.replyTo?.messageId ? msg.replyTo : null;
  return {
    id: msg._id.toString(),
    kind: msg.kind === "system" ? "system" : "text",
    from: mine ? "me" : "them",
    text: deleted ? "This message was deleted" : decryptChatText(msg.text),
    attachments,
    /** Prefer clients formatting `createdAt` in the user's local timezone. */
    time: "",
    createdAt: createdAt.toISOString(),
    /** Sent only (single grey). */
    delivered: mine ? deliveredToPeer : false,
    /** Delivered + opened/read by peer (double blue). */
    read: mine ? readByPeer : false,
    edited,
    deleted,
    editedAt: msg.editedAt ? new Date(msg.editedAt).toISOString() : null,
    replyTo:
      reply && !deleted
        ? {
            id: reply.messageId.toString(),
            from: reply.sender.toString() === viewerId ? ("me" as const) : ("them" as const),
            text: reply.deleted ? "" : decryptChatText(reply.text),
            hasImage: Boolean(reply.hasImage) && !reply.deleted,
            deleted: Boolean(reply.deleted),
          }
        : null,
    listingId,
    listing: listingId
      ? {
          id: listingId,
          title: listingTitle || "Listing",
          price:
            msg.listingPrice != null && Number(msg.listingPrice) > 0
              ? `₹${Number(msg.listingPrice).toLocaleString("en-IN")}`
              : "",
          image: absolutizeMediaUrl(msg.listingImage),
          href: sanitizeListingHref(msg.listingHref),
        }
      : null,
  };
}

async function markDeliveredForViewer(conversationId: string, viewerId: string) {
  await Message.updateMany(
    {
      conversation: conversationId,
      sender: { $ne: viewerId },
      deliveredTo: { $ne: viewerId },
    },
    { $addToSet: { deliveredTo: viewerId } },
  );
}

export async function listConversations(userId: string) {
  const rows = await Conversation.find({
    participants: userId,
    hiddenFor: { $ne: userId },
  })
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .limit(100);

  // Opening inbox = delivered (double grey) for messages from others
  let deliveryReceipt: {
    conversationId: string;
    messageIds: string[];
    participantIds: string[];
  }[] = [];
  if (rows.length) {
    const pending = await Message.find({
      conversation: { $in: rows.map((c) => c._id) },
      sender: { $ne: userId },
      deliveredTo: { $ne: userId },
    }).select("_id conversation sender");
    if (pending.length) {
      await Message.updateMany(
        { _id: { $in: pending.map((m) => m._id) } },
        { $addToSet: { deliveredTo: userId } },
      );
      const byConv = new Map<string, string[]>();
      for (const m of pending) {
        const cid = m.conversation.toString();
        const list = byConv.get(cid) || [];
        list.push(m._id.toString());
        byConv.set(cid, list);
      }
      deliveryReceipt = rows
        .filter((c) => byConv.has(c._id.toString()))
        .map((c) => ({
          conversationId: c._id.toString(),
          messageIds: byConv.get(c._id.toString()) || [],
          participantIds: c.participants.map((p) => p.toString()),
        }));
    }
  }

  const otherIds = rows
    .map((c) => c.participants.map((p) => p.toString()).find((id) => id !== userId))
    .filter(Boolean) as string[];

  // Independent lookups run together; sequentially each one adds a database round trip.
  const [users, me, soldCounts, reviewStats, onlineFlags] = await Promise.all([
    User.find({ _id: { $in: otherIds } }),
    User.findById(userId).select("blockedUsers").lean(),
    Listing.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
      {
        $match: {
          seller: {
            $in: otherIds
              .filter((id) => mongoose.isValidObjectId(id))
              .map((id) => new mongoose.Types.ObjectId(id)),
          },
          status: "sold",
        },
      },
      { $group: { _id: "$seller", n: { $sum: 1 } } },
    ]),
    Promise.all(
      otherIds.map(async (id) => {
        try {
          const stats = await getSellerReviewStats(id);
          return [id, stats] as const;
        } catch {
          return [id, { averageRating: 0, totalReviews: 0 }] as const;
        }
      }),
    ),
    Promise.all(
      otherIds.map(async (id) => {
        if (isUserOnline(id)) return [id, true] as const;
        const redis = await isUserOnlineRedis(id);
        return [id, redis === true] as const;
      }),
    ),
  ]);
  const userMap = new Map(users.map((u) => [u._id.toString(), u]));
  const blockedByMe = new Set((me?.blockedUsers || []).map((id) => String(id)));
  const soldMap = new Map(soldCounts.map((r) => [r._id.toString(), r.n]));
  const reviewMap = new Map(reviewStats);
  const onlineMap = new Map(onlineFlags);

  const conversations = rows.map((c) => {
    const otherId = c.participants.map((p) => p.toString()).find((id) => id !== userId) || "";
    const other = userMap.get(otherId);
    const unread = Number(c.unreadBy?.get?.(userId) || 0);
    const createdAt = (other as (InstanceType<typeof User> & { createdAt?: Date }) | undefined)
      ?.createdAt;
    const reviews = reviewMap.get(otherId) || {
      averageRating: 0,
      totalReviews: 0,
    };
    const itemsSold = soldMap.get(otherId) || 0;
    return {
      id: c._id.toString(),
      name: other?.name || "User",
      avatar: absolutizeMediaUrl(other?.avatar),
      online: otherId ? Boolean(onlineMap.get(otherId)) : false,
      verified: false,
      lastMessage: decryptChatText(c.lastMessageText || ""),
      lastMessageAt: c.lastMessageAt ? new Date(c.lastMessageAt).toISOString() : null,
      time: formatListTime(c.lastMessageAt),
      unread,
      listing: {
        title: (c.listingTitle || "").trim() || "Conversation",
        price:
          c.listingPrice != null && Number(c.listingPrice) > 0
            ? `₹${Number(c.listingPrice).toLocaleString("en-IN")}`
            : "",
        image: absolutizeMediaUrl(c.listingImage),
        href: sanitizeListingHref(c.listingHref),
      },
      participantId: otherId,
      blockedByMe: blockedByMe.has(otherId),
      blocked:
        blockedByMe.has(otherId) || (other?.blockedUsers || []).some((id) => String(id) === userId),
      seller: {
        rating: Number(reviews.averageRating) || 0,
        reviews: Number(reviews.totalReviews) || 0,
        memberSince: memberSinceYear(createdAt),
        itemsSold,
        responseRate: "Usually responds",
        responseTime: "Usually within a few hours",
        yearsOn: yearsOnLabel(createdAt),
        createdAt: createdAt?.toISOString?.() ?? null,
      },
    };
  });

  return { conversations, deliveryReceipt };
}

async function findConversationForParticipant(userId: string, conversationId: string) {
  if (!mongoose.isValidObjectId(conversationId)) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
  }
  const conversation = await Conversation.findById(conversationId);
  if (!conversation || !conversation.participants.some((p) => p.toString() === userId)) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
  }
  return conversation;
}

/** Marks everything the peer sent as delivered + read and clears this user's unread count. */
async function markReadForViewer(userId: string, conversation: InstanceType<typeof Conversation>) {
  const conversationId = conversation._id.toString();
  await markDeliveredForViewer(conversationId, userId);

  const unreadFromOthers = await Message.find({
    conversation: conversationId,
    sender: { $ne: userId },
    readBy: { $ne: userId },
  }).select("_id");

  await Message.updateMany(
    {
      conversation: conversationId,
      sender: { $ne: userId },
      readBy: { $ne: userId },
    },
    { $addToSet: { readBy: userId, deliveredTo: userId } },
  );
  const hadUnread = Number(conversation.unreadBy?.get?.(userId) || 0) > 0;
  if (conversation.unreadBy && hadUnread) {
    conversation.unreadBy.set(userId, 0);
    await conversation.save();
  }

  try {
    await markMessageNotificationsRead(userId, conversationId);
  } catch {
    /* opening the thread still succeeds if notification cleanup fails */
  }

  return {
    conversationId,
    readerId: userId,
    messageIds: unreadFromOthers.map((m) => m._id.toString()),
    participantIds: conversation.participants.map((p) => p.toString()),
    hadUnread,
  };
}

export async function getMessages(userId: string, conversationId: string) {
  const conversation = await findConversationForParticipant(userId, conversationId);
  const readReceipt = await markReadForViewer(userId, conversation);

  const latest = await Message.find({ conversation: conversationId, hiddenFor: { $ne: userId } })
    .sort({ createdAt: -1 })
    .limit(200);
  latest.reverse();

  return {
    messages: latest.map((m) => serializeMessage(m, userId)),
    readReceipt,
  };
}

/** Called while a thread is on screen, so messages that arrive in realtime get read ticks too. */
export async function markConversationRead(userId: string, conversationId: string) {
  const conversation = await findConversationForParticipant(userId, conversationId);
  return markReadForViewer(userId, conversation);
}

export async function sendMessage(
  userId: string,
  conversationId: string,
  text: string,
  opts?: {
    kind?: "text" | "system";
    createdAt?: Date;
    attachments?: { url: string; name?: string; mime?: string }[];
    replyToId?: string;
  },
) {
  if (!mongoose.isValidObjectId(conversationId)) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
  }
  const conversation = await Conversation.findById(conversationId);
  if (!conversation || !conversation.participants.some((p) => p.toString() === userId)) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
  }

  const otherId = conversation.participants.map((p) => p.toString()).find((id) => id !== userId);
  if (otherId && (await isEitherBlocked(userId, otherId))) {
    throw new AppError(403, "You can't message this user", "BLOCKED");
  }

  const kind = opts?.kind === "system" ? "system" : "text";
  const storedText = text.trim();
  const attachments = (opts?.attachments || [])
    .filter((file) => file.url.trim())
    .slice(0, 4)
    .map((file) => ({
      url: file.url.trim(),
      name: (file.name || "").trim(),
      mime: (file.mime || "").trim(),
    }));
  if (!storedText && !attachments.length) {
    throw new AppError(400, "Message is empty", "VALIDATION_ERROR");
  }
  const hasPdf = attachments.some(
    (file) => file.mime === "application/pdf" || /\.pdf$/i.test(file.url),
  );
  const preview = storedText || (attachments.length ? (hasPdf ? "PDF" : "Photo") : "");

  let replyTo: {
    messageId: mongoose.Types.ObjectId;
    sender: mongoose.Types.ObjectId;
    text: string;
    hasImage: boolean;
  } | null = null;
  if (opts?.replyToId && kind === "text") {
    if (!mongoose.isValidObjectId(opts.replyToId)) {
      throw new AppError(400, "Reply target not found", "VALIDATION_ERROR");
    }
    const quoted = await Message.findOne({
      _id: opts.replyToId,
      conversation: conversation._id,
      kind: "text",
      deletedAt: null,
    });
    if (!quoted) {
      throw new AppError(400, "Reply target not found", "VALIDATION_ERROR");
    }
    const quotedFiles = quoted.attachments || [];
    const quotedText = decryptChatText(quoted.text);
    const placeholderOnly =
      quotedFiles.length > 0 && (quotedText === "Photo" || quotedText === "PDF");
    replyTo = {
      messageId: quoted._id,
      sender: quoted.sender,
      text: placeholderOnly ? "" : quotedText.slice(0, 300),
      hasImage: quotedFiles.some(
        (file) => file.mime !== "application/pdf" && !/\.pdf($|\?)/i.test(String(file.url)),
      ),
    };
  }

  const message = await Message.create({
    conversation: conversation._id,
    sender: userId,
    text: storedText,
    attachments,
    kind,
    replyTo,
    readBy: [userId],
    deliveredTo: [userId],
    listingId: conversation.listingId || null,
    listingTitle: conversation.listingTitle || "",
    listingImage: conversation.listingImage || "",
    listingPrice: conversation.listingPrice ?? null,
    listingHref: conversation.listingHref || "",
    ...(opts?.createdAt ? { createdAt: opts.createdAt, updatedAt: opts.createdAt } : {}),
  });

  conversation.lastMessageText = preview;
  conversation.lastMessageAt = new Date();
  if (conversation.hiddenFor?.length) {
    conversation.hiddenFor = [];
  }
  const recipients: string[] = [];
  for (const p of conversation.participants) {
    const pid = p.toString();
    if (pid === userId) {
      conversation.unreadBy?.set(pid, 0);
    } else if (kind === "text") {
      const prev = Number(conversation.unreadBy?.get?.(pid) || 0);
      conversation.unreadBy?.set(pid, prev + 1);
      recipients.push(pid);
    }
  }
  await conversation.save();

  // Instant double-grey when recipient is already online (socket connected).
  let messageDoc = message;
  if (kind === "text" && recipients.some((rid) => isUserOnline(rid))) {
    const onlineIds = recipients.filter((rid) => isUserOnline(rid));
    if (onlineIds.length) {
      await Message.updateOne(
        { _id: message._id },
        { $addToSet: { deliveredTo: { $each: onlineIds } } },
      );
      const refreshed = await Message.findById(message._id);
      if (refreshed) messageDoc = refreshed;
    }
  }

  if (kind === "text") {
    const sender = await User.findById(userId);
    for (const rid of recipients) {
      await createNotification({
        userId: rid,
        type: "message",
        title: `New message from ${sender?.name || "Someone"}`,
        body: preview.slice(0, 140),
        href: `/messages?c=${conversation._id.toString()}`,
        image: absolutizeMediaUrl(sender?.avatar),
      });
    }
  }

  return {
    conversationId: conversation._id.toString(),
    message: serializeMessage(messageDoc, userId),
    participantIds: conversation.participants.map((p) => p.toString()),
  };
}

const DUPLICATE_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;

function hashText(text: string) {
  return createHash("sha1").update(text.trim().toLowerCase()).digest("hex").slice(0, 16);
}

/** Same text from the same sender in this thread within the window (message text is encrypted at rest). */
async function findRecentDuplicate(conversationId: string, senderId: string, text: string) {
  const needle = text.trim().toLowerCase();
  const recent = await Message.find({
    conversation: conversationId,
    sender: senderId,
    kind: { $ne: "system" },
    deletedAt: null,
    createdAt: { $gte: new Date(Date.now() - DUPLICATE_REQUEST_WINDOW_MS) },
  })
    .sort({ createdAt: -1 })
    .limit(20);
  return recent.find((m) => decryptChatText(m.text).trim().toLowerCase() === needle) ?? null;
}

export async function startConversation(
  userId: string,
  input: z.infer<typeof startConversationSchema>,
) {
  if (!mongoose.isValidObjectId(input.recipientId)) {
    throw new AppError(400, "Invalid recipient", "VALIDATION_ERROR");
  }
  if (input.recipientId === userId) {
    throw new AppError(400, "Cannot message yourself", "VALIDATION_ERROR");
  }
  const recipient = await User.findById(input.recipientId);
  if (!recipient) throw new AppError(404, "Recipient not found", "NOT_FOUND");

  const key = makeParticipantKey(userId, input.recipientId);
  const sortedParticipants = [userId, input.recipientId].sort();

  let listingDoc: InstanceType<typeof Listing> | null = null;
  let listingMeta: {
    listingId?: mongoose.Types.ObjectId | null;
    listingTitle: string;
    listingImage: string;
    listingPrice: number;
    listingHref: string;
  } = {
    listingId: null,
    listingTitle: "",
    listingImage: "",
    listingPrice: 0,
    listingHref: "/browse",
  };

  if (input.listingId && mongoose.isValidObjectId(input.listingId)) {
    listingDoc = await Listing.findById(input.listingId);
    if (listingDoc) {
      listingMeta = {
        listingId: listingDoc._id,
        listingTitle: listingDoc.title,
        listingImage: listingDoc.images?.[0] || "",
        listingPrice: listingDoc.price,
        listingHref: listingHrefFromDoc(listingDoc),
      };
    }
  }

  // One thread per user pair — listing is only current context.
  let conversation =
    (await Conversation.findOne({ participantKey: key })) ||
    (await Conversation.findOne({
      participants: { $all: [userId, input.recipientId], $size: 2 },
    }));

  const isNew = !conversation;
  const prevListingId = conversation?.listingId?.toString?.() || "";
  const nextListingId = listingMeta.listingId?.toString?.() || "";
  const listingChanged = Boolean(nextListingId && nextListingId !== prevListingId);

  if (!conversation) {
    conversation = await Conversation.create({
      participantKey: key,
      participants: sortedParticipants,
      ...listingMeta,
      unreadBy: {},
    });
  } else {
    if (!conversation.participantKey) {
      conversation.participantKey = key;
    }
    if (listingMeta.listingId) {
      conversation.listingId = listingMeta.listingId;
      conversation.listingTitle = listingMeta.listingTitle;
      conversation.listingImage = listingMeta.listingImage;
      conversation.listingPrice = listingMeta.listingPrice;
      conversation.listingHref = listingMeta.listingHref;
    }
    await conversation.save();
  }

  const conversationId = conversation._id.toString();

  // Listing context card BEFORE the opening text (stable ordering).
  if (listingMeta.listingId && (isNew || listingChanged)) {
    // Stamped just before the opener we send next, so it falls on the same day as that chat.
    const last = conversation.lastMessageAt ? new Date(conversation.lastMessageAt).getTime() : 0;
    const tCard = new Date(Math.max(last + 1, Date.now() - 20));
    await sendMessage(userId, conversationId, chatListingSwitchMessage(listingMeta.listingTitle), {
      kind: "system",
      createdAt: tCard,
    });
  }

  const rawText = (input.text || "").trim();
  const isGenericOpener =
    !rawText ||
    /^hi,?\s+is this still available\??$/i.test(rawText) ||
    /^hi!?\s+is this still available\??$/i.test(rawText) ||
    /^hi,?\s+is ["“]?[^"”]+["”]?\s+still available\??$/i.test(rawText);

  const categoryAware = listingDoc
    ? chatOpeningMessage({
        title: listingMeta.listingTitle || listingDoc.title,
        category: listingDoc.category,
        subcategory: listingDoc.subcategory,
        intent: listingDoc.intent,
      })
    : "";

  const textToSend = isGenericOpener ? categoryAware || rawText : rawText;

  if (textToSend) {
    // Listing buttons (book, offer, message) must not post the same request twice when
    // tapped repeatedly; the lock covers concurrent taps, the lookup covers later ones.
    const lockKey = `chat:start:${conversationId}:${userId}:${hashText(textToSend)}`;
    const locked = await kv.setIfAbsent(lockKey, "1", 15).catch(() => true);
    const existing = await findRecentDuplicate(conversationId, userId, textToSend);
    if (existing || !locked) {
      return {
        conversationId,
        message: existing ? serializeMessage(existing, userId) : null,
        participantIds: conversation.participants.map((p) => p.toString()),
        duplicate: true,
      };
    }
    try {
      return await sendMessage(userId, conversationId, textToSend, {
        createdAt: new Date(Date.now()),
      });
    } finally {
      void kv.del(lockKey).catch(() => undefined);
    }
  }

  return {
    conversationId,
    message: null,
    participantIds: conversation.participants.map((p) => p.toString()),
  };
}

export async function editMessage(userId: string, messageId: string, text: string) {
  if (!mongoose.isValidObjectId(messageId)) {
    throw new AppError(404, "Message not found", "NOT_FOUND");
  }
  const message = await Message.findById(messageId);
  if (!message) throw new AppError(404, "Message not found", "NOT_FOUND");
  if (message.sender.toString() !== userId) {
    throw new AppError(403, "You can only edit your messages", "FORBIDDEN");
  }
  if (message.kind === "system") {
    throw new AppError(400, "System messages cannot be edited", "VALIDATION_ERROR");
  }
  if (message.deletedAt) {
    throw new AppError(400, "Deleted messages cannot be edited", "VALIDATION_ERROR");
  }
  const conversation = await Conversation.findById(message.conversation);
  if (!conversation || !conversation.participants.some((p) => p.toString() === userId)) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
  }

  message.text = text.trim();
  message.editedAt = new Date();
  await message.save();

  if (conversation.lastMessageText && !String(conversation.lastMessageText).startsWith("enc:")) {
    // Best-effort: if this was the latest message, refresh preview
    const latest = await Message.findOne({ conversation: conversation._id })
      .sort({ createdAt: -1 })
      .select("_id");
    if (latest && latest._id.toString() === messageId) {
      conversation.lastMessageText = text.trim();
      await conversation.save();
    }
  } else {
    const latest = await Message.findOne({ conversation: conversation._id })
      .sort({ createdAt: -1 })
      .select("_id");
    if (latest && latest._id.toString() === messageId) {
      conversation.lastMessageText = text.trim();
      await conversation.save();
    }
  }

  return {
    conversationId: conversation._id.toString(),
    message: serializeMessage(message, userId),
    participantIds: conversation.participants.map((p) => p.toString()),
  };
}

export async function deleteMessage(userId: string, messageId: string) {
  if (!mongoose.isValidObjectId(messageId)) {
    throw new AppError(404, "Message not found", "NOT_FOUND");
  }
  const message = await Message.findById(messageId);
  if (!message) throw new AppError(404, "Message not found", "NOT_FOUND");
  if (message.sender.toString() !== userId) {
    throw new AppError(403, "You can only delete your messages", "FORBIDDEN");
  }
  if (message.kind === "system") {
    throw new AppError(400, "System messages cannot be deleted", "VALIDATION_ERROR");
  }
  const conversation = await Conversation.findById(message.conversation);
  if (!conversation || !conversation.participants.some((p) => p.toString() === userId)) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
  }

  message.deletedAt = new Date();
  // Schema requires non-empty text. Clients show “This message was deleted” when deletedAt is set.
  message.text = "deleted";
  await message.save();
  await Message.updateMany(
    { conversation: conversation._id, "replyTo.messageId": message._id },
    { $set: { "replyTo.text": "", "replyTo.hasImage": false, "replyTo.deleted": true } },
  );

  const latest = await Message.findOne({ conversation: conversation._id })
    .sort({ createdAt: -1 })
    .select("_id deletedAt text");
  if (latest && latest._id.toString() === messageId) {
    conversation.lastMessageText = "This message was deleted";
    await conversation.save();
  }

  return {
    conversationId: conversation._id.toString(),
    message: serializeMessage(message, userId),
    participantIds: conversation.participants.map((p) => p.toString()),
  };
}

/** "Delete for me": only this user stops seeing the message; the peer's copy is untouched. */
export async function hideMessage(userId: string, messageId: string) {
  if (!mongoose.isValidObjectId(messageId)) {
    throw new AppError(404, "Message not found", "NOT_FOUND");
  }
  const message = await Message.findById(messageId);
  if (!message) throw new AppError(404, "Message not found", "NOT_FOUND");
  if (message.kind === "system") {
    throw new AppError(400, "System messages cannot be deleted", "VALIDATION_ERROR");
  }
  const conversation = await findConversationForParticipant(
    userId,
    message.conversation.toString(),
  );
  await Message.updateOne({ _id: message._id }, { $addToSet: { hiddenFor: userId } });
  return { conversationId: conversation._id.toString(), messageId };
}

export async function deleteConversation(userId: string, conversationId: string) {
  if (!mongoose.isValidObjectId(conversationId)) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
  }
  const conversation = await Conversation.findById(conversationId);
  if (!conversation || !conversation.participants.some((p) => p.toString() === userId)) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
  }
  const alreadyHidden = (conversation.hiddenFor || []).some((id) => id.toString() === userId);
  if (!alreadyHidden) {
    conversation.hiddenFor = [
      ...(conversation.hiddenFor || []),
      new mongoose.Types.ObjectId(userId),
    ];
  }
  conversation.unreadBy?.set(userId, 0);
  await conversation.save();
  return { ok: true as const };
}
