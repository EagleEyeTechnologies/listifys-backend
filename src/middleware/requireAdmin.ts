import type { NextFunction, Request, Response } from "express";
import { isOwnerEmail } from "../config/env.js";
import { AdminAccount } from "../modules/admin/adminAccount.model.js";
import { touchAdminLogin } from "../modules/admin/admin.platform.service.js";
import { User } from "../modules/users/user.model.js";
import { AppError } from "../utils/AppError.js";
import { requireAuth } from "./auth.js";

export type AdminRole = "owner" | "super" | "moderator" | "support";

declare global {
  namespace Express {
    interface Request {
      adminEmail?: string;
      adminName?: string;
      adminRole?: AdminRole;
      isOwner?: boolean;
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
    const owner = isOwnerEmail(email);
    let account = await AdminAccount.findOne({ email, isActive: true });

    if (!owner && !account) {
      return next(new AppError(403, "Access denied. Admins and owners only.", "FORBIDDEN"));
    }

    if (owner) {
      await AdminAccount.updateOne(
        { email },
        {
          $set: { email, role: "owner", isActive: true },
          $setOnInsert: { addedByEmail: "system" },
        },
        { upsert: true },
      );
      account = await AdminAccount.findOne({ email });
    }

    const role = (owner ? "owner" : (account?.role as AdminRole) || "moderator") as AdminRole;
    req.adminEmail = email;
    req.adminName = user.name || email.split("@")[0] || "Admin";
    req.adminRole = role;
    req.isOwner = owner;
    void touchAdminLogin(email);
    next();
  } catch (err) {
    next(err);
  }
}

/** requireAuth then owner (OWNER_EMAILS) or active AdminAccount. */
export const requireAdmin = [requireAuth, assertAdmin];

/** Owners only (role management). */
export async function requireOwner(req: Request, _res: Response, next: NextFunction) {
  if (!req.isOwner) {
    return next(new AppError(403, "Only owners can manage admin roles", "FORBIDDEN"));
  }
  next();
}
