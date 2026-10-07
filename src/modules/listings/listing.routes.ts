import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { optionalAuth, requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../utils/AppError.js";
import {
  browseListings,
  countListingsByCategory,
  createListing,
  createListingSchema,
  getListingById,
  listMyListings,
  listQuerySchema,
  softDeleteListing,
  topHiringCompanies,
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
  optionalAuth,
  asyncHandler(async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "Invalid query", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await browseListings(req.countryCode, parsed.data, req.userId);
    res.json({ success: true, data });
  }),
);

listingsRouter.get(
  "/counts",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const counts = await countListingsByCategory(req.countryCode);
    res.json({ success: true, data: { counts } });
  }),
);

listingsRouter.get(
  "/hiring-companies",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const limit = Number(req.query.limit) || 5;
    const items = await topHiringCompanies(req.countryCode, req.userId, limit);
    res.json({ success: true, data: { items } });
  }),
);

listingsRouter.get(
  "/:id",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const anonViewerId = String(req.headers["x-viewer-id"] || "")
      .replace(/[^\w-]/g, "")
      .slice(0, 80);
    const data = await getListingById(String(req.params.id), req.userId, anonViewerId);
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
