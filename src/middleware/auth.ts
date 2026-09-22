import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../modules/auth/tokens.js";
import { AppError } from "../utils/AppError.js";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const cookieToken = (req as Request & { cookies?: Record<string, string> }).cookies?.accessToken;
  const token = bearer || cookieToken;
  if (!token) {
    return next(new AppError(401, "Authentication required", "UNAUTHORIZED"));
  }
  const payload = verifyAccessToken(token);
  req.userId = payload.sub;
  next();
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const cookieToken = (req as Request & { cookies?: Record<string, string> }).cookies
      ?.accessToken;
    const token = bearer || cookieToken;
    if (token) {
      const payload = verifyAccessToken(token);
      req.userId = payload.sub;
    }
  } catch {
    // ignore invalid token for optional auth
  }
  next();
}
