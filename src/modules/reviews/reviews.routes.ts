import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../utils/AppError.js";
import {
  createReviewSchema,
  createSellerReview,
  deleteOwnSellerReview,
  getSellerReviewStats,
  listSellerReviews,
  updateOwnSellerReview,
  updateReviewSchema,
} from "./reviews.service.js";

export const reviewsRouter = Router();

reviewsRouter.get(
  "/:sellerId/stats",
  asyncHandler(async (req, res) => {
    const stats = await getSellerReviewStats(String(req.params.sellerId));
    res.json({ success: true, data: stats });
  }),
);

reviewsRouter.get(
  "/:sellerId",
  asyncHandler(async (req, res) => {
    const limit = Number(req.query.limit) || 20;
    const data = await listSellerReviews(String(req.params.sellerId), limit);
    res.json({ success: true, data });
  }),
);

reviewsRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = createReviewSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR");
    }
    const data = await createSellerReview(String(req.userId), parsed.data);
    res.status(201).json({ success: true, data });
  }),
);

reviewsRouter.patch(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = updateReviewSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR");
    }
    const data = await updateOwnSellerReview(
      String(req.userId),
      String(req.params.id),
      parsed.data,
    );
    res.json({ success: true, data });
  }),
);

reviewsRouter.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = await deleteOwnSellerReview(String(req.userId), String(req.params.id));
    res.json({ success: true, data });
  }),
);
