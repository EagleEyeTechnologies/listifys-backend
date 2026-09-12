import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../utils/AppError.js";
import {
  browseListings,
  createListing,
  createListingSchema,
  getListingById,
  listMyListings,
  listQuerySchema,
  softDeleteListing,
  updateListing,
  updateListingSchema,
} from "./listing.service.js";

export const listingsRouter = Router();

listingsRouter.get(
  "/mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = await listMyListings(req.userId!);
    res.json({ success: true, data });
  }),
);

listingsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "Invalid query", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await browseListings(req.countryCode, parsed.data);
    res.json({ success: true, data });
  }),
);

listingsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const data = await getListingById(String(req.params.id));
    res.json({ success: true, data });
  }),
);

listingsRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = createListingSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await createListing(req.userId!, req.countryCode, parsed.data);
    res.status(201).json({ success: true, data });
  }),
);

listingsRouter.patch(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = updateListingSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await updateListing(String(req.params.id), req.userId!, parsed.data);
    res.json({ success: true, data });
  }),
);

listingsRouter.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = await softDeleteListing(String(req.params.id), req.userId!);
    res.json({ success: true, data });
  }),
);
