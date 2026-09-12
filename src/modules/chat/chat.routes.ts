import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../utils/AppError.js";
import {
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
    const data = await listConversations(req.userId!);
    res.json({ success: true, data });
  }),
);

chatRouter.get(
  "/conversations/:id/messages",
  asyncHandler(async (req, res) => {
    const data = await getMessages(req.userId!, String(req.params.id));
    res.json({ success: true, data });
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
    }
    res.status(201).json({ success: true, data: result.message });
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
