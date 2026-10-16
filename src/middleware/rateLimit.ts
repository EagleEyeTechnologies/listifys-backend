import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";

/**
 * Account key for auth routes. Unauthenticated calls used to share the
 * office NAT IP, so one person's OTP retries locked everyone else.
 */
export function authRateSubject(body: unknown, userId?: string): string | null {
  if (userId) return `user:${userId}`;
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const email = typeof record.email === "string" ? record.email.trim().toLowerCase() : "";
  if (email.includes("@")) return `email:${email}`;
  const phone = typeof record.phone === "string" ? record.phone.replace(/\D/g, "") : "";
  if (phone.length >= 8) {
    const code = typeof record.phoneCode === "string" ? record.phoneCode.replace(/\D/g, "") : "";
    return `phone:${code}:${phone}`;
  }
  const refresh = typeof record.refreshToken === "string" ? record.refreshToken.trim() : "";
  if (refresh.length >= 10) return `refresh:${refresh.slice(-16)}`;
  return null;
}

function viewerId(req: Request): string | null {
  const raw = req.get("x-viewer-id") || "";
  const id = raw.trim().slice(0, 80);
  if (!/^[A-Za-z0-9:_-]{8,80}$/.test(id)) return null;
  return id;
}

function ipKey(req: Request): string {
  return ipKeyGenerator(req.ip ?? "unknown");
}

/** Per browser or signed-in user, so teammates on one network do not share a bucket. */
function actorKey(req: Request): string {
  if (req.userId) return `user:${req.userId}`;
  const viewer = viewerId(req);
  if (viewer) return `viewer:${viewer}`;
  return `ip:${ipKey(req)}`;
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

const tooManyRequests = {
  success: false,
  error: { code: "RATE_LIMIT", message: "Too many requests" },
};

/**
 * Global API limiter. Authenticated traffic is keyed per user. Anonymous
 * traffic is keyed per browser (x-viewer-id) so a shared office IP does not
 * burn one bucket for the whole team.
 */
export const globalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: actorKey,
  skip: shouldSkipRateLimit,
  message: tooManyRequests,
});

/**
 * Backstop for one network. High enough for a 10–15 person office actively
 * testing, still finite if someone rotates viewer ids.
 */
export const globalIpRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40000,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: ipKey,
  skip: shouldSkipRateLimit,
  message: tooManyRequests,
});

/** Per email, phone, or signed-in user. One account's OTP guesses stay on that account. */
export const authSubjectRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => authRateSubject(req.body, req.userId) ?? "anonymous",
  skip: (req) => authRateSubject(req.body, req.userId) == null,
  message: {
    success: false,
    error: {
      code: "RATE_LIMIT",
      message: "Too many attempts for this account. Wait a few minutes and try again.",
    },
  },
});

/** Shared-network ceiling for auth. A whole office can sign in; one IP cannot spray forever. */
export const authIpRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 800,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: ipKey,
  message: {
    success: false,
    error: {
      code: "RATE_LIMIT",
      message: "Too many sign-in attempts from this network. Wait a few minutes and try again.",
    },
  },
});
