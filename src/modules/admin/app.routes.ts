import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { getActiveAppUpdates } from "./admin.platform.service.js";

/** Public mobile endpoints (no auth). */
export const appPublicRouter = Router();

appPublicRouter.get(
  "/updates",
  asyncHandler(async (_req, res) => {
    const data = await getActiveAppUpdates();
    res.json({ success: true, data });
  }),
);
