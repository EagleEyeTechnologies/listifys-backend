import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../utils/AppError.js";
import { createJobAlert, createJobAlertSchema, listJobAlerts } from "./jobAlert.service.js";

export const jobAlertsRouter = Router();

jobAlertsRouter.use(requireAuth);

jobAlertsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const data = await listJobAlerts(req.userId!);
    res.json({ success: true, data });
  }),
);

jobAlertsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = createJobAlertSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Enter a keyword for this alert", "VALIDATION_ERROR");
    }
    const data = await createJobAlert(req.userId!, parsed.data);
    res.status(201).json({ success: true, data });
  }),
);
