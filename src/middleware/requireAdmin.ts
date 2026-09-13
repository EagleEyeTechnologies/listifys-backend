import type { NextFunction, Request, Response } from "express";
import { isAdminEmail } from "../config/env.js";
import { AdminAccount } from "../modules/admin/adminAccount.model.js";
import { touchAdminLogin } from "../modules/admin/admin.platform.service.js";
import { User } from "../modules/users/user.model.js";
import { AppError } from "../utils/AppError.js";
import { requireAuth } from "./auth.js";

declare global {
  namespace Express {
    interface Request {
      adminEmail?: string;
      adminName?: string;
    }
  }
}

async function assertAdmin(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.userId) {
      return next(new AppError(401, "Authentication required", "UNAUTHORIZED"));
    }
    const user = await User.findById(req.userId).select("email name isActive");
    if (!user || !user.isActive) {
      return next(new AppError(401, "Authentication required", "UNAUTHORIZED"));
    }
    const email = (user.email || "").trim().toLowerCase();
    const envAllowed = isAdminEmail(email);
    const account = await AdminAccount.findOne({ email, isActive: true });
    if (!envAllowed && !account) {
      return next(
        new AppError(403, "Access denied. Admin only.", "FORBIDDEN"),
      );
    }
    if (!account && envAllowed) {
      await AdminAccount.updateOne(
        { email },
        { $setOnInsert: { email, role: "super", isActive: true } },
        { upsert: true },
      );
    }
    req.adminEmail = email;
    req.adminName = user.name || email.split("@")[0] || "Admin";
    void touchAdminLogin(email);
    next();
  } catch (err) {
    next(err);
  }
}

/** requireAuth then ADMIN_EMAILS allowlist. */
export const requireAdmin = [requireAuth, assertAdmin];
