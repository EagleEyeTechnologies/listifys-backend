import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../utils/AppError.js";
import {
  createOffer,
  createOfferSchema,
  listOffers,
  updateOffer,
  updateOfferSchema,
} from "./offers.service.js";

export const offersRouter = Router();

offersRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = await listOffers(req.userId!);
    res.json({ success: true, data });
  }),
);

offersRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = createOfferSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        "Invalid payload",
        "VALIDATION_ERROR",
        parsed.error.flatten(),
      );
    }
    const data = await createOffer(req.userId!, parsed.data);
    res.status(201).json({ success: true, data });
  }),
);

offersRouter.patch(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = updateOfferSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        "Invalid payload",
        "VALIDATION_ERROR",
        parsed.error.flatten(),
      );
    }
    const data = await updateOffer(req.userId!, String(req.params.id), parsed.data);
    res.json({ success: true, data });
  }),
);
