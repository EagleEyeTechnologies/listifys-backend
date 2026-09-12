import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../utils/AppError.js";
import {
  clearSaved,
  listSaved,
  toggleSaved,
  toggleSavedSchema,
} from "./saved.service.js";

export const savedRouter = Router();

savedRouter.use(requireAuth);

savedRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const data = await listSaved(req.userId!);
    res.json({ success: true, data });
  }),
);

savedRouter.post(
  "/toggle",
  asyncHandler(async (req, res) => {
    const parsed = toggleSavedSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        "listingId required",
        "VALIDATION_ERROR",
        parsed.error.flatten(),
      );
    }
    const data = await toggleSaved(req.userId!, parsed.data.listingId);
    res.json({ success: true, data });
  }),
);

savedRouter.delete(
  "/",
  asyncHandler(async (req, res) => {
    const data = await clearSaved(req.userId!);
    res.json({ success: true, data });
  }),
);
