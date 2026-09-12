import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { paymentConfigFor } from "./payments.service.js";

export const paymentsRouter = Router();

paymentsRouter.get(
  "/config",
  asyncHandler(async (req, res) => {
    res.json({
      success: true,
      data: paymentConfigFor(req.countryCode),
    });
  }),
);
