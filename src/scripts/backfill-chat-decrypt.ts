/**
 * Decrypt legacy `enc:` message / conversation preview fields in-place.
 * Dry-run by default. Pass --write to persist.
 *
 * Usage:
 *   npx tsx src/scripts/backfill-chat-decrypt.ts
 *   npx tsx src/scripts/backfill-chat-decrypt.ts --write
 */
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { decryptChatText } from "../modules/chat/chat.crypto.js";
import { logger } from "../utils/logger.js";

const write = process.argv.includes("--write");

async function main() {
  const uri = env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI required");

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error("No DB");

  let msgScanned = 0;
  let msgUpdated = 0;
  let msgFailed = 0;
  const msgCursor = db.collection("messages").find({ text: { $regex: "^enc:" } });

  for await (const doc of msgCursor) {
    msgScanned += 1;
    const raw = String(doc.text || "");
    const plain = decryptChatText(raw);
    if (!plain || plain.startsWith("[Message unavailable")) {
      msgFailed += 1;
      continue;
    }
    if (write) {
      await db.collection("messages").updateOne({ _id: doc._id }, { $set: { text: plain } });
    }
    msgUpdated += 1;
  }

  let convScanned = 0;
  let convUpdated = 0;
  let convFailed = 0;
  const convCursor = db.collection("conversations").find({ lastMessageText: { $regex: "^enc:" } });

  for await (const doc of convCursor) {
    convScanned += 1;
    const raw = String(doc.lastMessageText || "");
    const plain = decryptChatText(raw);
    if (!plain || plain.startsWith("[Message unavailable")) {
      convFailed += 1;
      continue;
    }
    if (write) {
      await db
        .collection("conversations")
        .updateOne({ _id: doc._id }, { $set: { lastMessageText: plain } });
    }
    convUpdated += 1;
  }

  logger.info("chat decrypt backfill", {
    write,
    messages: { scanned: msgScanned, wouldUpdate: msgUpdated, failed: msgFailed },
    conversations: {
      scanned: convScanned,
      wouldUpdate: convUpdated,
      failed: convFailed,
    },
  });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
