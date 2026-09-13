import type { Request } from "express";
import { AdminActivity } from "./adminActivity.model.js";

export async function logAdminActivity(
  req: Pick<Request, "userId" | "adminEmail" | "adminName" | "ip">,
  input: {
    action: string;
    target?: string;
    section?: string;
    metadata?: Record<string, unknown>;
  },
) {
  try {
    await AdminActivity.create({
      adminId: req.userId,
      adminEmail: req.adminEmail || "",
      adminName: req.adminName || "",
      action: input.action,
      target: input.target || "",
      section: input.section || "General",
      ip: req.ip || "",
      metadata: input.metadata || {},
    });
  } catch {
    /* audit log must not break requests */
  }
}
