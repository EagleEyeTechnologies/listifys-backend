/**
 * Merge duplicate 1:1 conversations that were keyed by listingId.
 * Keeps one conversation per sorted participant pair and reassigns messages.
 *
 * Usage:
 *   npx tsx src/scripts/merge-chat-conversations.ts
 *   npx tsx src/scripts/merge-chat-conversations.ts --write
 */
import mongoose from "mongoose";
import { connectMongo } from "../db/mongo.js";
import { Conversation, makeParticipantKey } from "../modules/chat/conversation.model.js";
import { Message } from "../modules/chat/message.model.js";
import { logger } from "../utils/logger.js";

const write = process.argv.includes("--write");

type LeanConvo = {
  _id: mongoose.Types.ObjectId;
  participants: mongoose.Types.ObjectId[];
  participantKey?: string | null;
  listingId?: mongoose.Types.ObjectId | null;
  listingTitle?: string;
  listingImage?: string;
  listingPrice?: number;
  listingHref?: string;
  lastMessageText?: string;
  lastMessageAt?: Date | null;
  unreadBy?: Map<string, number> | Record<string, number>;
  updatedAt?: Date;
};

function unreadEntries(
  unreadBy?: Map<string, number> | Record<string, number>,
): [string, number][] {
  if (!unreadBy) return [];
  if (unreadBy instanceof Map) return [...unreadBy.entries()];
  return Object.entries(unreadBy).map(([k, v]) => [k, Number(v) || 0]);
}

async function main() {
  await connectMongo();

  const all = (await Conversation.find({}).lean().exec()) as unknown as LeanConvo[];

  const groups = new Map<string, LeanConvo[]>();
  for (const c of all) {
    const ids = (c.participants || []).map((p) => p.toString()).filter(Boolean);
    if (ids.length !== 2) continue;
    const key = makeParticipantKey(ids[0], ids[1]);
    const list = groups.get(key) || [];
    list.push(c);
    groups.set(key, list);
  }

  let pairsWithDupes = 0;
  let conversationsRemoved = 0;
  let messagesMoved = 0;
  let keysBackfilled = 0;

  for (const [key, list] of groups) {
    if (list.length === 1) {
      const only = list[0];
      if (!only.participantKey || only.participantKey !== key) {
        keysBackfilled += 1;
        if (write) {
          await Conversation.updateOne({ _id: only._id }, { $set: { participantKey: key } });
        }
      }
      continue;
    }

    pairsWithDupes += 1;
    const sorted = [...list].sort((a, b) => {
      const aAt = a.lastMessageAt
        ? new Date(a.lastMessageAt).getTime()
        : a.updatedAt
          ? new Date(a.updatedAt).getTime()
          : 0;
      const bAt = b.lastMessageAt
        ? new Date(b.lastMessageAt).getTime()
        : b.updatedAt
          ? new Date(b.updatedAt).getTime()
          : 0;
      return bAt - aAt;
    });
    const canonical = sorted[0];
    const duplicates = sorted.slice(1);

    const mergedUnread = new Map<string, number>();
    for (const c of sorted) {
      for (const [uid, n] of unreadEntries(c.unreadBy)) {
        mergedUnread.set(uid, (mergedUnread.get(uid) || 0) + n);
      }
    }

    let bestListing = {
      listingId: canonical.listingId || null,
      listingTitle: canonical.listingTitle || "",
      listingImage: canonical.listingImage || "",
      listingPrice: canonical.listingPrice || 0,
      listingHref: canonical.listingHref || "",
    };
    for (const c of sorted) {
      if (c.listingId && (!bestListing.listingId || c === canonical)) {
        bestListing = {
          listingId: c.listingId,
          listingTitle: c.listingTitle || "",
          listingImage: c.listingImage || "",
          listingPrice: c.listingPrice || 0,
          listingHref: c.listingHref || "",
        };
      }
    }

    let latestAt = canonical.lastMessageAt ? new Date(canonical.lastMessageAt) : null;
    let latestText = canonical.lastMessageText || "";
    for (const c of sorted) {
      const at = c.lastMessageAt ? new Date(c.lastMessageAt) : null;
      if (at && (!latestAt || at > latestAt)) {
        latestAt = at;
        latestText = c.lastMessageText || latestText;
      }
    }

    logger.info("Merge conversation pair", {
      key,
      keep: canonical._id.toString(),
      drop: duplicates.map((d) => d._id.toString()),
      write,
    });

    if (write) {
      for (const dup of duplicates) {
        const moved = await Message.updateMany(
          { conversation: dup._id },
          { $set: { conversation: canonical._id } },
        );
        messagesMoved += moved.modifiedCount || 0;
        await Conversation.deleteOne({ _id: dup._id });
        conversationsRemoved += 1;
      }

      await Conversation.updateOne(
        { _id: canonical._id },
        {
          $set: {
            participantKey: key,
            participants: key.split(":"),
            ...bestListing,
            lastMessageAt: latestAt,
            lastMessageText: latestText,
            unreadBy: Object.fromEntries(mergedUnread),
          },
        },
      );
    } else {
      conversationsRemoved += duplicates.length;
      for (const dup of duplicates) {
        const count = await Message.countDocuments({ conversation: dup._id });
        messagesMoved += count;
      }
    }
  }

  logger.info("Chat conversation merge complete", {
    write,
    totalConversations: all.length,
    uniquePairs: groups.size,
    pairsWithDupes,
    conversationsRemoved,
    messagesMoved,
    keysBackfilled,
  });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
