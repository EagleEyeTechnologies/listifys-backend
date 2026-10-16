import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { kv } from "../../redis/client.js";
import { AppError } from "../../utils/AppError.js";

export type AccessPayload = {
  sub: string;
  type: "access";
  sid?: string;
  iat?: number;
};

export type RefreshPayload = {
  sub: string;
  type: "refresh";
  jti: string;
  sid?: string;
  iat?: number;
};

/** How long a signed-in device stays revocable. Matches the refresh-token cookie. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export function signAccessToken(userId: string, sessionId?: string): string {
  return jwt.sign(
    {
      sub: userId,
      type: "access",
      ...(sessionId ? { sid: sessionId } : {}),
    } satisfies AccessPayload,
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_EXPIRE as jwt.SignOptions["expiresIn"] },
  );
}

export function signRefreshToken(userId: string, jti: string, sessionId?: string): string {
  return jwt.sign(
    {
      sub: userId,
      type: "refresh",
      jti,
      ...(sessionId ? { sid: sessionId } : {}),
    } satisfies RefreshPayload,
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRE as jwt.SignOptions["expiresIn"] },
  );
}

export function verifyAccessToken(token: string): AccessPayload {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessPayload;
    if (payload.type !== "access") throw new Error("wrong type");
    return payload;
  } catch {
    throw new AppError(401, "Invalid or expired access token", "UNAUTHORIZED");
  }
}

export function verifyRefreshToken(token: string): RefreshPayload {
  try {
    const payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshPayload;
    if (payload.type !== "refresh") throw new Error("wrong type");
    return payload;
  } catch {
    throw new AppError(401, "Invalid or expired refresh token", "UNAUTHORIZED");
  }
}

export async function storeRefreshToken(userId: string, jti: string): Promise<void> {
  await kv.set(`refresh:${userId}:${jti}`, "1", 60 * 60 * 24 * 30);
}

export async function revokeRefreshToken(userId: string, jti: string): Promise<void> {
  // Soft-revoke with short grace so multi-tab refresh races don't force logout
  await kv.set(`refresh:${userId}:${jti}`, "grace", 120);
}

export async function destroyRefreshToken(userId: string, jti: string): Promise<void> {
  await kv.del(`refresh:${userId}:${jti}`);
}

export async function storeSession(sessionId: string, userId: string): Promise<void> {
  await kv.set(`session:${sessionId}`, userId, SESSION_TTL_SECONDS);
}

export async function destroySession(sessionId: string): Promise<void> {
  if (!sessionId) return;
  await kv.del(`session:${sessionId}`);
}

export async function sessionOwner(sessionId: string): Promise<string | null> {
  if (!sessionId) return null;
  return kv.get(`session:${sessionId}`);
}

/** Access and refresh tokens issued before this timestamp are no longer accepted. */
export async function setSessionFloor(userId: string): Promise<void> {
  await kv.set(`session-floor:${userId}`, String(Date.now()), SESSION_TTL_SECONDS);
}

export async function sessionFloor(userId: string): Promise<number> {
  const raw = await kv.get(`session-floor:${userId}`);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export async function assertAccessSession(payload: AccessPayload): Promise<void> {
  const floor = await sessionFloor(payload.sub);
  // JWT iat is whole seconds, so a token minted just after the floor can look older.
  if (floor && payload.iat && payload.iat * 1000 + 5000 < floor) {
    throw new AppError(401, "Session ended. Sign in again.", "UNAUTHORIZED");
  }
  if (!payload.sid) return;
  const owner = await sessionOwner(payload.sid);
  if (owner !== payload.sub) {
    throw new AppError(401, "Session ended. Sign in again.", "UNAUTHORIZED");
  }
}

export async function isRefreshTokenValid(userId: string, jti: string): Promise<boolean> {
  const v = await kv.get(`refresh:${userId}:${jti}`);
  return v === "1" || v === "grace";
}

export function issueTokenPair(userId: string, jti: string, sessionId?: string) {
  return {
    accessToken: signAccessToken(userId, sessionId),
    refreshToken: signRefreshToken(userId, jti, sessionId),
  };
}
