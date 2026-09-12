import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../utils/AppError.js";
import {
  clearCompare,
  listCompare,
  toggleCompare,
  toggleCompareSchema,
} from "./compare.service.js";

export const compareRouter = Router();

compareRouter.use(requireAuth);

compareRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const data = await listCompare(req.userId!);
    res.json({ success: true, data });
  }),
);

compareRouter.post(
  "/toggle",
  asyncHandler(async (req, res) => {
    const parsed = toggleCompareSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        "listingId required",
        "VALIDATION_ERROR",
        parsed.error.flatten(),
      );
    }
    const data = await toggleCompare(req.userId!, parsed.data.listingId);
    res.json({ success: true, data });
  }),
);

compareRouter.delete(
  "/",
  asyncHandler(async (req, res) => {
    const data = await clearCompare(req.userId!);
    res.json({ success: true, data });
  }),
);
