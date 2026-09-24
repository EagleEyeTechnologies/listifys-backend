import mongoose from "mongoose";
import { z } from "zod";
import {
  Conversation,
  makeParticipantKey,
} from "./conversation.model.js";
import { Message } from "./message.model.js";
import { User } from "../users/user.model.js";
import { Listing } from "../listings/listing.model.js";
import { AppError } from "../../utils/AppError.js";
import { listingHrefFromDoc } from "./listingHref.js";
import { decryptChatText } from "./chat.crypto.js";
import { createNotification } from "../notifications/notification.service.js";
import { isUserOnline, isUserOnlineRedis } from "./presence.js";
import { absolutizeMediaUrl } from "../../utils/mediaUrl.js";
import { getSellerReviewStats } from "../reviews/reviews.service.js";
import {
  chatListingSwitchMessage,
  chatOpeningMessage,
} from "./chatOpeningMessage.js";

export const startConversationSchema = z.object({
  recipientId: z.string().min(1),
  listingId: z.string().optional(),
  text: z.string().min(1).max(5000).optional(),
});

export const sendMessageSchema = z.object({
  text: z.string().min(1).max(5000),
});

export const editMessageSchema = z.object({
  text: z.string().min(1).max(5000),
});

/** Relative list time — ms diffs are timezone-safe. */
function formatListTime(date?: Date | null) {
  if (!date) return "";
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  // Absolute calendar day in the viewer's locale is applied on clients when needed;
  // list preview stays relative / short date from the Instant.
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function memberSinceYear(createdAt?: Date | null): string {
  if (!createdAt) return "—";
  return String(createdAt.getFullYear());
}

function yearsOnLabel(createdAt?: Date | null): string {
  if (!createdAt) return "New on Listifys";
  const years = Math.max(
    0,
    Math.floor(
      (Date.now() - createdAt.getTime()) / (365.25 * 24 * 60 * 60 * 1000),
    ),
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

export function serializeMessage(
  msg: InstanceType<typeof Message>,
  viewerId: string,
) {
  const senderId = msg.sender.toString();
  const mine = senderId === viewerId;
  const createdAt =
    (msg as InstanceType<typeof Message> & { createdAt?: Date }).createdAt ||
    new Date();
  const deleted = Boolean(msg.deletedAt);
  const edited = Boolean(msg.editedAt) && !deleted;
  const readByPeer = (msg.readBy || []).some(
    (id) => id.toString() !== senderId,
  );
  const deliveredToPeer =
    readByPeer ||
    (msg.deliveredTo || []).some((id) => id.toString() !== senderId);
  const listingId = msg.listingId?.toString?.() || null;
  const listingTitle = (msg.listingTitle || "").trim();
  return {
    id: msg._id.toString(),
    kind: msg.kind === "system" ? "system" : "text",
    from: mine ? "me" : "them",
    text: deleted
      ? "This message was deleted"
      : decryptChatText(msg.text),
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

async function markDeliveredForViewer(
  conversationId: string,
  viewerId: string,
) {
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
  const rows = await Conversation.find({ participants: userId })
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
    .map((c) =>
      c.participants.map((p) => p.toString()).find((id) => id !== userId),
    )
    .filter(Boolean) as string[];

  const users = await User.find({ _id: { $in: otherIds } });
  const userMap = new Map(users.map((u) => [u._id.toString(), u]));

  const soldCounts = await Listing.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
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
  ]);
  const soldMap = new Map(
    soldCounts.map((r) => [r._id.toString(), r.n]),
  );

  const reviewStats = await Promise.all(
    otherIds.map(async (id) => {
      try {
        const stats = await getSellerReviewStats(id);
        return [id, stats] as const;
      } catch {
        return [id, { averageRating: 0, totalReviews: 0 }] as const;
      }
    }),
  );
  const reviewMap = new Map(reviewStats);

  const onlineFlags = await Promise.all(
    otherIds.map(async (id) => {
      if (isUserOnline(id)) return [id, true] as const;
      const redis = await isUserOnlineRedis(id);
      return [id, redis === true] as const;
    }),
  );
  const onlineMap = new Map(onlineFlags);

  const conversations = rows.map((c) => {
    const otherId =
      c.participants.map((p) => p.toString()).find((id) => id !== userId) || "";
    const other = userMap.get(otherId);
    const unread = Number(c.unreadBy?.get?.(userId) || 0);
    const createdAt = (
      other as (InstanceType<typeof User> & { createdAt?: Date }) | undefined
    )?.createdAt;
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

export async function getMessages(userId: string, conversationId: string) {
  if (!mongoose.isValidObjectId(conversationId)) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
  }
  const conversation = await Conversation.findById(conversationId);
  if (
    !conversation ||
    !conversation.participants.some((p) => p.toString() === userId)
  ) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
  }

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
  if (conversation.unreadBy) {
    conversation.unreadBy.set(userId, 0);
    await conversation.save();
  }

  const fresh = await Message.find({ conversation: conversationId })
    .sort({ createdAt: 1 })
    .limit(200);

  return {
    messages: fresh.map((m) => serializeMessage(m, userId)),
    readReceipt: {
      conversationId,
      readerId: userId,
      messageIds: unreadFromOthers.map((m) => m._id.toString()),
      participantIds: conversation.participants.map((p) => p.toString()),
    },
  };
}

export async function sendMessage(
  userId: string,
  conversationId: string,
  text: string,
  opts?: { kind?: "text" | "system"; createdAt?: Date },
) {
  if (!mongoose.isValidObjectId(conversationId)) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
  }
  const conversation = await Conversation.findById(conversationId);
  if (
    !conversation ||
    !conversation.participants.some((p) => p.toString() === userId)
  ) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
  }

  const kind = opts?.kind === "system" ? "system" : "text";
  const storedText = text.trim();
  const message = await Message.create({
    conversation: conversation._id,
    sender: userId,
    text: storedText,
    kind,
    readBy: [userId],
    deliveredTo: [userId],
    listingId: conversation.listingId || null,
    listingTitle: conversation.listingTitle || "",
    listingImage: conversation.listingImage || "",
    listingPrice: conversation.listingPrice ?? null,
    listingHref: conversation.listingHref || "",
    ...(opts?.createdAt ? { createdAt: opts.createdAt, updatedAt: opts.createdAt } : {}),
  });

  conversation.lastMessageText = storedText;
  conversation.lastMessageAt = new Date();
  const recipients: string[] = [];
  for (const p of conversation.participants) {
    const pid = p.toString();
    if (pid === userId) {
      conversation.unreadBy?.set(pid, 0);
    } else {
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
        body: text.slice(0, 140),
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
  const listingChanged = Boolean(
    nextListingId && nextListingId !== prevListingId,
  );

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
    // Place just after any prior messages, but before the opener we send next.
    const base = conversation.lastMessageAt
      ? new Date(conversation.lastMessageAt).getTime()
      : Date.now() - 40;
    const tCard = new Date(Math.min(base + 10, Date.now() - 20));
    await sendMessage(
      userId,
      conversationId,
      chatListingSwitchMessage(listingMeta.listingTitle),
      { kind: "system", createdAt: tCard },
    );
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

  const textToSend = isGenericOpener
    ? categoryAware || rawText
    : rawText;

  if (textToSend) {
    const sent = await sendMessage(userId, conversationId, textToSend, {
      createdAt: new Date(Date.now()),
    });
    return sent;
  }

  return {
    conversationId,
    message: null,
    participantIds: conversation.participants.map((p) => p.toString()),
  };
}

export async function editMessage(
  userId: string,
  messageId: string,
  text: string,
) {
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
  if (
    !conversation ||
    !conversation.participants.some((p) => p.toString() === userId)
  ) {
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
  if (
    !conversation ||
    !conversation.participants.some((p) => p.toString() === userId)
  ) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
  }

  message.deletedAt = new Date();
  message.text = "";
  await message.save();

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

export async function deleteConversation(userId: string, conversationId: string) {
  if (!mongoose.isValidObjectId(conversationId)) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
  }
  const conversation = await Conversation.findById(conversationId);
  if (
    !conversation ||
    !conversation.participants.some((p) => p.toString() === userId)
  ) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
  }
  // Soft-hide for this user by clearing their unread and removing them is too destructive
  // for a shared thread. Delete the whole thread only if both would agree — for now,
  // remove the conversation document and its messages (participant-initiated clear).
  await Message.deleteMany({ conversation: conversation._id });
  await Conversation.deleteOne({ _id: conversation._id });
  return { ok: true as const };
}

