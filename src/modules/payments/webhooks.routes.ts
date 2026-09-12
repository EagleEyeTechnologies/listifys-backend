import { Router, raw, type Request, type Response, type NextFunction } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  handleRazorpayWebhook,
  handleStripeWebhook,
} from "./payments.webhooks.js";
import { AppError } from "../../utils/AppError.js";

export const webhooksRouter = Router();

/** Preserve raw body for signature verification */
function rawJson(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  return raw({ type: "application/json" })(req, res, (err) => {
    if (err) return next(err);
    next();
  });
}

webhooksRouter.post(
  "/razorpay",
  rawJson,
  asyncHandler(async (req, res) => {
    const signature = String(req.headers["x-razorpay-signature"] || "");
    const body = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body || {}));
    if (!signature) {
      throw new AppError(400, "Missing signature", "INVALID_SIGNATURE");
    }
    const result = await handleRazorpayWebhook(body, signature);
    res.json({ success: true, data: result });
  }),
);

webhooksRouter.post(
  "/stripe",
  rawJson,
  asyncHandler(async (req, res) => {
    const signature = String(req.headers["stripe-signature"] || "");
    const body = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body || {}));
    if (!signature) {
      throw new AppError(400, "Missing signature", "INVALID_SIGNATURE");
    }
    const result = await handleStripeWebhook(body, signature);
    res.json({ success: true, data: result });
  }),
);
