import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../utils/AppError.js";
import {
  deleteConversation,
  deleteMessage,
  editMessage,
  editMessageSchema,
  getMessages,
  hideMessage,
  listConversations,
  markConversationRead,
  sendMessage,
  sendMessageSchema,
  startConversation,
  startConversationSchema,
} from "./chat.service.js";
import { getIo } from "./socket.js";

export const chatRouter = Router();

/** Blue ticks for the sender, plus `chat:seen` so the reader's other tabs/devices drop the badge. */
function emitReadReceipt(receipt: {
  conversationId: string;
  readerId: string;
  messageIds: string[];
  participantIds: string[];
  hadUnread: boolean;
}) {
  const io = getIo();
  if (!io) return;
  if (receipt.messageIds.length) {
    for (const pid of receipt.participantIds) {
      if (pid === receipt.readerId) continue;
      io.to(`user:${pid}`).emit("chat:read", {
        conversationId: receipt.conversationId,
        readerId: receipt.readerId,
        messageIds: receipt.messageIds,
      });
    }
  }
  if (receipt.messageIds.length || receipt.hadUnread) {
    io.to(`user:${receipt.readerId}`).emit("chat:seen", {
      conversationId: receipt.conversationId,
    });
  }
}

chatRouter.use(requireAuth);

chatRouter.get(
  "/conversations",
  asyncHandler(async (req, res) => {
    const result = await listConversations(req.userId!);
    const io = getIo();
    if (io && result.deliveryReceipt.length) {
      for (const receipt of result.deliveryReceipt) {
        for (const pid of receipt.participantIds) {
          if (pid === req.userId) continue;
          io.to(`user:${pid}`).emit("chat:delivered", {
            conversationId: receipt.conversationId,
            messageIds: receipt.messageIds,
            readerId: req.userId,
          });
        }
      }
    }
    res.json({ success: true, data: result.conversations });
  }),
);

chatRouter.get(
  "/conversations/:id/messages",
  asyncHandler(async (req, res) => {
    const result = await getMessages(req.userId!, String(req.params.id));
    emitReadReceipt(result.readReceipt);
    res.json({ success: true, data: result.messages });
  }),
);

chatRouter.post(
  "/conversations/:id/read",
  asyncHandler(async (req, res) => {
    const receipt = await markConversationRead(req.userId!, String(req.params.id));
    emitReadReceipt(receipt);
    res.json({ success: true, data: { ok: true, messageIds: receipt.messageIds } });
  }),
);

chatRouter.post(
  "/conversations/:id/messages",
  asyncHandler(async (req, res) => {
    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid message", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const result = await sendMessage(req.userId!, String(req.params.id), parsed.data.text, {
      attachments: parsed.data.attachments,
      replyToId: parsed.data.replyToId,
    });
    const io = getIo();
    if (io) {
      for (const pid of result.participantIds) {
        io.to(`user:${pid}`).emit("chat:message", {
          conversationId: result.conversationId,
          message: {
            ...result.message,
            from: pid === req.userId ? "me" : "them",
          },
        });
      }
      if (result.message.delivered) {
        for (const pid of result.participantIds) {
          if (pid === req.userId) continue;
          io.to(`user:${req.userId}`).emit("chat:delivered", {
            conversationId: result.conversationId,
            messageIds: [result.message.id],
            deliveredTo: pid,
          });
        }
      }
    }
    res.status(201).json({ success: true, data: result.message });
  }),
);

chatRouter.patch(
  "/messages/:id",
  asyncHandler(async (req, res) => {
    const parsed = editMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid message", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const result = await editMessage(req.userId!, String(req.params.id), parsed.data.text);
    const io = getIo();
    if (io) {
      for (const pid of result.participantIds) {
        io.to(`user:${pid}`).emit("chat:message:update", {
          conversationId: result.conversationId,
          message: {
            ...result.message,
            from: pid === req.userId ? "me" : "them",
          },
        });
      }
    }
    res.json({ success: true, data: result.message });
  }),
);

chatRouter.delete(
  "/messages/:id",
  asyncHandler(async (req, res) => {
    const result = await deleteMessage(req.userId!, String(req.params.id));
    const io = getIo();
    if (io) {
      for (const pid of result.participantIds) {
        io.to(`user:${pid}`).emit("chat:message:update", {
          conversationId: result.conversationId,
          message: {
            ...result.message,
            from: pid === req.userId ? "me" : "them",
          },
        });
      }
    }
    res.json({ success: true, data: result.message });
  }),
);

chatRouter.post(
  "/messages/:id/hide",
  asyncHandler(async (req, res) => {
    const result = await hideMessage(req.userId!, String(req.params.id));
    getIo()?.to(`user:${req.userId}`).emit("chat:message:hidden", result);
    res.json({ success: true, data: result });
  }),
);

chatRouter.delete(
  "/conversations/:id",
  asyncHandler(async (req, res) => {
    const data = await deleteConversation(req.userId!, String(req.params.id));
    res.json({ success: true, data });
  }),
);

chatRouter.post(
  "/conversations",
  asyncHandler(async (req, res) => {
    const parsed = startConversationSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const result = await startConversation(req.userId!, parsed.data);
    const duplicate = "duplicate" in result && result.duplicate === true;
    const io = getIo();
    if (io && result.message && !duplicate) {
      for (const pid of result.participantIds) {
        io.to(`user:${pid}`).emit("chat:message", {
          conversationId: result.conversationId,
          message: {
            ...result.message,
            from: pid === req.userId ? "me" : "them",
          },
        });
      }
    }
    res.status(201).json({
      success: true,
      data: {
        conversationId: result.conversationId,
        message: result.message,
        duplicate,
      },
    });
  }),
);
