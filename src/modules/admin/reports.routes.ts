import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { createUserReport, createUserReportSchema } from "./report.service.js";

export const reportsRouter = Router();

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
