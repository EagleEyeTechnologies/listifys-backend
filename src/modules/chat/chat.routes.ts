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
  listConversations,
  sendMessage,
  sendMessageSchema,
  startConversation,
  startConversationSchema,
} from "./chat.service.js";
import { getIo } from "./socket.js";

export const chatRouter = Router();

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
    const io = getIo();
    if (io && result.readReceipt.messageIds.length) {
      for (const pid of result.readReceipt.participantIds) {
        if (pid === req.userId) continue;
        io.to(`user:${pid}`).emit("chat:read", {
          conversationId: result.readReceipt.conversationId,
          readerId: result.readReceipt.readerId,
          messageIds: result.readReceipt.messageIds,
        });
      }
    }
    res.json({ success: true, data: result.messages });
  }),
);

chatRouter.post(
  "/conversations/:id/messages",
  asyncHandler(async (req, res) => {
    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid message", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const result = await sendMessage(
      req.userId!,
      String(req.params.id),
      parsed.data.text,
    );
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
    const result = await editMessage(
      req.userId!,
      String(req.params.id),
      parsed.data.text,
    );
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
    const io = getIo();
    if (io && result.message) {
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
      },
    });
  }),
);
