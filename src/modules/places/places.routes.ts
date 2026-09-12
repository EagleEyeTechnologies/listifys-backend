import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  autocomplete,
  placeDetails,
  reverseGeocode,
} from "./places.service.js";

export const placesRouter = Router();

placesRouter.get(
  "/autocomplete",
  asyncHandler(async (req, res) => {
    const results = await autocomplete({
      q: req.query.q as string | undefined,
      lat: req.query.lat as string | undefined,
      lng: req.query.lng as string | undefined,
      sessiontoken: req.query.sessiontoken as string | undefined,
      country:
        (req.query.country as string | undefined) ||
        req.countryCode?.toLowerCase(),
    });
    res.json({ success: true, data: results });
  }),
);

placesRouter.get(
  "/details",
  asyncHandler(async (req, res) => {
    const result = await placeDetails({
      placeId: req.query.placeId as string | undefined,
      sessiontoken: req.query.sessiontoken as string | undefined,
    });
    res.json({ success: true, data: result });
  }),
);

placesRouter.get(
  "/reverse",
  asyncHandler(async (req, res) => {
    const result = await reverseGeocode({
      lat: req.query.lat as string | undefined,
      lng: req.query.lng as string | undefined,
    });
    res.json({ success: true, data: result });
  }),
);
