import type { NextFunction, Request, Response } from "express";
import { assertAccessSession, verifyAccessToken } from "../modules/auth/tokens.js";
import { AppError } from "../utils/AppError.js";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      sessionId?: string;
    }
  }
}

function readAccessToken(req: Request) {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const cookieToken = (req as Request & { cookies?: Record<string, string> }).cookies?.accessToken;
  return bearer || cookieToken;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = readAccessToken(req);
    if (!token) {
      return next(new AppError(401, "Authentication required", "UNAUTHORIZED"));
    }
    const payload = verifyAccessToken(token);
    await assertAccessSession(payload);
    req.userId = payload.sub;
    req.sessionId = payload.sid;
    next();
  } catch (err) {
    next(err);
  }
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = readAccessToken(req);
    if (token) {
      const payload = verifyAccessToken(token);
      await assertAccessSession(payload);
      req.userId = payload.sub;
      req.sessionId = payload.sid;
    }
  } catch {
    // ignore invalid token for optional auth
  }
  next();
}
