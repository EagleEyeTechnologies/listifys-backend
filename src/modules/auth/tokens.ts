import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { kv } from "../../redis/client.js";
import { AppError } from "../../utils/AppError.js";

export type AccessPayload = {
  sub: string;
  type: "access";
};

export type RefreshPayload = {
  sub: string;
  type: "refresh";
  jti: string;
};

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId, type: "access" } satisfies AccessPayload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRE as jwt.SignOptions["expiresIn"],
  });
}

export function signRefreshToken(userId: string, jti: string): string {
  return jwt.sign(
    { sub: userId, type: "refresh", jti } satisfies RefreshPayload,
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

export async function isRefreshTokenValid(userId: string, jti: string): Promise<boolean> {
  const v = await kv.get(`refresh:${userId}:${jti}`);
  return v === "1" || v === "grace";
}

export function issueTokenPair(userId: string, jti: string) {
  return {
    accessToken: signAccessToken(userId),
    refreshToken: signRefreshToken(userId, jti),
  };
}
