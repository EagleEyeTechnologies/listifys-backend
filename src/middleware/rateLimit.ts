import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";

function clientKey(req: Request): string {
  if (req.userId) return `user:${req.userId}`;
  // IPv6-safe IP key (required when customizing keyGenerator in express-rate-limit v8+)
  return ipKeyGenerator(req.ip ?? "unknown");
}

function shouldSkipRateLimit(req: Request): boolean {
  const path = req.path || "";
  const url = req.originalUrl || path;
  if (path === "/health" || path.startsWith("/health") || url.startsWith("/health")) {
    return true;
  }
  // Chat GETs are polled by web/app while sockets reconnect; they require auth
  // and were exhausting the shared office-IP bucket during team testing.
  if (req.method === "GET" && (path.startsWith("/api/chat") || url.startsWith("/api/chat"))) {
    return true;
  }
  return false;
}

/**
 * Global API limiter. Authenticated traffic is keyed per user so a shared
 * office/NAT IP no longer burns one bucket for the whole team.
 */
export const globalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req) => (req.userId ? 5000 : 1500),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientKey,
  skip: shouldSkipRateLimit,
  message: {
    success: false,
    error: { code: "RATE_LIMIT", message: "Too many requests" },
  },
});

export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientKey,
  message: {
    success: false,
    error: { code: "RATE_LIMIT", message: "Too many auth attempts" },
  },
});
