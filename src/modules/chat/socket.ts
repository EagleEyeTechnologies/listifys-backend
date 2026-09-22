import type { Server as HttpServer } from "http";
import { Server } from "socket.io";
import { getAllowedOrigins } from "../../config/origins.js";
import { logger } from "../../utils/logger.js";
import { verifyAccessToken } from "../auth/tokens.js";
import { User } from "../users/user.model.js";
import { Conversation } from "./conversation.model.js";
import { sendMessage } from "./chat.service.js";
import {
  listOnlineUserIds,
  presenceSnapshot,
  trackSocketOffline,
  trackSocketOnline,
} from "./presence.js";

let io: Server | null = null;

export function getIo() {
  return io;
}

function emitPresenceOnline(userId: string) {
  io?.emit("user:online", { userId });
  io?.to(`presence:${userId}`).emit("user:online", { userId });
}

function emitPresenceOffline(userId: string, lastSeen: string) {
  const payload = { userId, lastSeen };
  io?.emit("user:offline", payload);
  io?.to(`presence:${userId}`).emit("user:offline", payload);
}

async function emitTypingToPeers(
  socket: { to: Server["to"]; id: string },
  conversationId: string,
  userId: string,
  event: "typing:start" | "typing:stop",
  payload: Record<string, unknown>,
) {
  socket.to(`conversation:${conversationId}`).emit(event, payload);
  try {
    const convo = await Conversation.findById(conversationId).select("participants").lean();
    for (const pid of convo?.participants || []) {
      const pidStr = String(pid);
      if (pidStr && pidStr !== userId) {
        io?.to(`user:${pidStr}`).emit(event, payload);
      }
    }
  } catch {
    /* ignore */
  }
}

export function initSocket(httpServer: HttpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: getAllowedOrigins(),
      credentials: true,
    },
    path: "/socket.io",
    pingTimeout: 60_000,
    pingInterval: 25_000,
    transports: ["websocket", "polling"],
  });

  io.use((socket, next) => {
    try {
      const token =
        (socket.handshake.auth?.token as string | undefined) ||
        (socket.handshake.headers.authorization?.startsWith("Bearer ")
          ? socket.handshake.headers.authorization.slice(7)
          : undefined);
      if (!token) return next(new Error("UNAUTHORIZED"));
      const payload = verifyAccessToken(token);
      socket.data.userId = payload.sub;
      next();
    } catch {
      next(new Error("UNAUTHORIZED"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;
    socket.join(`user:${userId}`);

    void (async () => {
      try {
        const user = await User.findById(userId).select("name").lean();
        socket.data.userName = user?.name || "User";
      } catch {
        socket.data.userName = "User";
      }
    })();

    trackSocketOnline(userId, socket.id, {
      onOnline: emitPresenceOnline,
      onOffline: emitPresenceOffline,
    });

    logger.info("socket connected", { userId, id: socket.id });

    socket.on("conversation:join", async (conversationId: unknown) => {
      if (typeof conversationId !== "string" || conversationId.length > 64) {
        return;
      }
      try {
        const ok = await Conversation.exists({
          _id: conversationId,
          participants: userId,
        });
        if (!ok) return;
        socket.join(`conversation:${conversationId}`);
      } catch {
        /* ignore */
      }
    });

    socket.on("conversation:leave", (conversationId: unknown) => {
      if (typeof conversationId !== "string" || conversationId.length > 64) {
        return;
      }
      socket.leave(`conversation:${conversationId}`);
    });

    socket.on("typing:start", (data: { conversationId?: string }) => {
      const conversationId = data?.conversationId;
      if (typeof conversationId !== "string" || conversationId.length > 64) {
        return;
      }
      void emitTypingToPeers(socket, conversationId, userId, "typing:start", {
        conversationId,
        userId,
        userName: socket.data.userName || "User",
      });
    });

    socket.on("typing:stop", (data: { conversationId?: string }) => {
      const conversationId = data?.conversationId;
      if (typeof conversationId !== "string" || conversationId.length > 64) {
        return;
      }
      void emitTypingToPeers(socket, conversationId, userId, "typing:stop", {
        conversationId,
        userId,
      });
    });

    socket.on("users:online", () => {
      socket.emit("users:online", listOnlineUserIds());
    });

    socket.on("user:lastSeen", async (data: { targetUserId?: string }) => {
      const targetUserId = data?.targetUserId;
      if (typeof targetUserId !== "string" || targetUserId.length > 64) {
        return;
      }
      socket.emit("user:lastSeen", await presenceSnapshot(targetUserId));
    });

    socket.on("presence:subscribe", async (data: { targetUserId?: string }) => {
      const targetUserId = data?.targetUserId;
      if (typeof targetUserId !== "string" || targetUserId.length > 64) {
        return;
      }
      if (targetUserId === userId) return;
      socket.join(`presence:${targetUserId}`);
      socket.emit("user:lastSeen", await presenceSnapshot(targetUserId));
    });

    socket.on("presence:unsubscribe", (data: { targetUserId?: string }) => {
      const targetUserId = data?.targetUserId;
      if (typeof targetUserId !== "string" || targetUserId.length > 64) {
        return;
      }
      if (targetUserId === userId) return;
      socket.leave(`presence:${targetUserId}`);
    });

    socket.on(
      "chat:send",
      async (payload: { conversationId: string; text: string }, ack?: (resp: unknown) => void) => {
        try {
          const result = await sendMessage(userId, payload.conversationId, payload.text);
          for (const pid of result.participantIds) {
            io?.to(`user:${pid}`).emit("chat:message", {
              conversationId: result.conversationId,
              message: {
                ...result.message,
                from: pid === userId ? "me" : "them",
              },
            });
          }
          ack?.({ success: true, data: result.message });
        } catch (err) {
          ack?.({
            success: false,
            error: err instanceof Error ? err.message : "Send failed",
          });
        }
      },
    );

    socket.on("disconnect", () => {
      trackSocketOffline(userId, socket.id, {
        onOnline: emitPresenceOnline,
        onOffline: emitPresenceOffline,
      });
      logger.debug("socket disconnected", { userId, id: socket.id });
    });
  });

  logger.info("Socket.IO ready");
  return io;
}
