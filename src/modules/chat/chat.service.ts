import mongoose from "mongoose";
import { z } from "zod";
import { Conversation } from "./conversation.model.js";
import { Message } from "./message.model.js";
import { User } from "../users/user.model.js";
import { Listing } from "../listings/listing.model.js";
import { AppError } from "../../utils/AppError.js";
import { listingHrefFromDoc } from "./listingHref.js";
import { decryptChatText } from "./chat.crypto.js";
import { createNotification } from "../notifications/notification.service.js";
import { isUserOnline } from "./presence.js";
import { absolutizeMediaUrl } from "../../utils/mediaUrl.js";

export const startConversationSchema = z.object({
  recipientId: z.string().min(1),
  listingId: z.string().optional(),
  text: z.string().min(1).max(5000).optional(),
});

export const sendMessageSchema = z.object({
  text: z.string().min(1).max(5000),
});

function formatTime(date?: Date | null) {
  if (!date) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatListTime(date?: Date | null) {
  if (!date) return "";
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
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
  const mine = msg.sender.toString() === viewerId;
  const createdAt =
    (msg as InstanceType<typeof Message> & { createdAt?: Date }).createdAt || new Date();
  return {
    id: msg._id.toString(),
    kind: msg.kind === "system" ? "system" : "text",
    from: mine ? "me" : "them",
    text: decryptChatText(msg.text),
    time: formatTime(createdAt),
    createdAt: createdAt.toISOString(),
    read: (msg.readBy || []).some((id) => id.toString() === viewerId) || mine,
  };
}

export async function listConversations(userId: string) {
  const rows = await Conversation.find({ participants: userId })
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .limit(100);

  const otherIds = rows
    .map((c) => c.participants.map((p) => p.toString()).find((id) => id !== userId))
    .filter(Boolean) as string[];

  const users = await User.find({ _id: { $in: otherIds } });
  const userMap = new Map(users.map((u) => [u._id.toString(), u]));

  return rows.map((c) => {
    const otherId = c.participants.map((p) => p.toString()).find((id) => id !== userId) || "";
    const other = userMap.get(otherId);
    const unread = Number(c.unreadBy?.get?.(userId) || 0);
    return {
      id: c._id.toString(),
      name: other?.name || "User",
      avatar: absolutizeMediaUrl(other?.avatar),
      online: otherId ? isUserOnline(otherId) : false,
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
    };
  });
}

export async function getMessages(userId: string, conversationId: string) {
  if (!mongoose.isValidObjectId(conversationId)) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
  }
  const conversation = await Conversation.findById(conversationId);
  if (!conversation || !conversation.participants.some((p) => p.toString() === userId)) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
  }

  const messages = await Message.find({ conversation: conversationId })
    .sort({ createdAt: 1 })
    .limit(200);

  // mark read
  await Message.updateMany(
    {
      conversation: conversationId,
      sender: { $ne: userId },
      readBy: { $ne: userId },
    },
    { $addToSet: { readBy: userId } },
  );
  if (conversation.unreadBy) {
    conversation.unreadBy.set(userId, 0);
    await conversation.save();
  }

  return messages.map((m) => serializeMessage(m, userId));
}

export async function sendMessage(userId: string, conversationId: string, text: string) {
  if (!mongoose.isValidObjectId(conversationId)) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
  }
  const conversation = await Conversation.findById(conversationId);
  if (!conversation || !conversation.participants.some((p) => p.toString() === userId)) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
  }

  const storedText = text.trim();
  const message = await Message.create({
    conversation: conversation._id,
    sender: userId,
    text: storedText,
    kind: "text",
    readBy: [userId],
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

  return {
    conversationId: conversation._id.toString(),
    message: serializeMessage(message, userId),
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

  let listingMeta: {
    listingId?: mongoose.Types.ObjectId;
    listingTitle: string;
    listingImage: string;
    listingPrice: number;
    listingHref: string;
  } = {
    listingTitle: "",
    listingImage: "",
    listingPrice: 0,
    listingHref: "/browse",
  };

  if (input.listingId && mongoose.isValidObjectId(input.listingId)) {
    const listing = await Listing.findById(input.listingId);
    if (listing) {
      listingMeta = {
        listingId: listing._id,
        listingTitle: listing.title,
        listingImage: listing.images?.[0] || "",
        listingPrice: listing.price,
        listingHref: listingHrefFromDoc(listing),
      };
    }
  }

  let conversation = await Conversation.findOne({
    participants: { $all: [userId, input.recipientId], $size: 2 },
    ...(listingMeta.listingId ? { listingId: listingMeta.listingId } : { listingId: null }),
  });

  if (!conversation) {
    conversation = await Conversation.create({
      participants: [userId, input.recipientId],
      ...listingMeta,
      unreadBy: {},
    });
  }

  if (input.text) {
    const sent = await sendMessage(userId, conversation._id.toString(), input.text);
    return sent;
  }

  return {
    conversationId: conversation._id.toString(),
    message: null,
    participantIds: conversation.participants.map((p) => p.toString()),
  };
}
