import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import {
  createUserReport,
  createUserReportSchema,
  getUserReportStatus,
  reportStatusQuerySchema,
} from "./report.service.js";

export const reportsRouter = Router();

reportsRouter.get(
  "/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = reportStatusQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "Invalid query", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await getUserReportStatus(req.userId!, parsed.data);
    res.json({ success: true, data });
  }),
);

reportsRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = createUserReportSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await createUserReport(req.userId!, parsed.data);
    res.status(data.duplicate ? 200 : 201).json({ success: true, data });
  }),
);
