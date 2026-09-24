import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../utils/AppError.js";
import { env } from "../../config/env.js";
import { getBoostPlan, listBoostPlans, formatMinor } from "./boost.plans.js";
import {
  createRazorpayOrder,
  createStripePaymentIntent,
  paymentConfigFor,
} from "../payments/payments.service.js";
import { createPendingBoostCheckout, expireDueCampaigns } from "./boost.service.js";
import { BoostCampaign } from "./boostCampaign.model.js";
import {
  confirmRazorpayPayment,
  confirmStripePaymentIntent,
} from "../payments/payments.webhooks.js";

export const boostRouter = Router();

boostRouter.get(
  "/plans",
  asyncHandler(async (req, res) => {
    await expireDueCampaigns();
    const plans = listBoostPlans(req.countryCode);
    res.json({
      success: true,
      data: {
        countryCode: req.countryCode,
        plans: plans.map((p) => ({
          ...p,
          amountDisplay: formatMinor(p.amountMinor, p.currency),
          totalDisplay: formatMinor(p.totalMinor, p.currency),
        })),
        payments: paymentConfigFor(req.countryCode),
      },
    });
  }),
);

boostRouter.get(
  "/campaigns",
  requireAuth,
  asyncHandler(async (req, res) => {
    await expireDueCampaigns();
    const rows = await BoostCampaign.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(50);
    res.json({
      success: true,
      data: {
        items: rows.map((c) => ({
          id: c._id.toString(),
          listingId: c.listingId?.toString(),
          listingTitle: c.listingTitle,
          listingImage: c.listingImage,
          planKey: c.planKey,
          planDays: c.planDays,
          status: c.status,
          countryCode: c.countryCode,
          currency: c.currency,
          totalMinor: c.totalMinor,
          startAt: c.startAt,
          endAt: c.endAt,
          activatedAt: c.activatedAt,
        })),
      },
    });
  }),
);

const checkoutSchema = z.object({
  planKey: z.enum(["3d", "7d", "15d"]),
  listingId: z.string().min(1),
});

boostRouter.post(
  "/checkout",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }

    const plan = getBoostPlan(parsed.data.planKey, req.countryCode);
    if (!plan) {
      throw new AppError(404, "Plan not found", "NOT_FOUND");
    }

    const cfg = paymentConfigFor(req.countryCode);
    if (!cfg.provider) {
      throw new AppError(
        503,
        "Payments are not configured for this market yet",
        "PAYMENTS_UNAVAILABLE",
      );
    }

    if (cfg.provider === "razorpay") {
      const order = await createRazorpayOrder({
        amountMinor: plan.totalMinor,
        currency: plan.currency,
        receipt: `boost_${plan.planKey}_${Date.now()}`,
        notes: {
          purpose: "boost",
          planKey: plan.planKey,
          userId: String(req.userId),
          listingId: parsed.data.listingId,
          countryCode: plan.countryCode,
        },
      });

      const { campaign, payment } = await createPendingBoostCheckout({
        userId: String(req.userId),
        plan,
        listingId: parsed.data.listingId,
        provider: "razorpay",
        providerOrderId: order.id,
      });

      res.json({
        success: true,
        data: {
          provider: "razorpay" as const,
          plan,
          keyId: env.RAZORPAY_KEY_ID,
          orderId: order.id,
          amountMinor: plan.totalMinor,
          currency: plan.currency,
          paymentId: payment._id.toString(),
          campaignId: campaign._id.toString(),
        },
      });
      return;
    }

    const intent = await createStripePaymentIntent({
      amountMinor: plan.totalMinor,
      currency: plan.currency,
      metadata: {
        purpose: "boost",
        planKey: plan.planKey,
        userId: String(req.userId),
        listingId: parsed.data.listingId,
        countryCode: plan.countryCode,
      },
    });

    const { campaign, payment } = await createPendingBoostCheckout({
      userId: String(req.userId),
      plan,
      listingId: parsed.data.listingId,
      provider: "stripe",
      providerPaymentId: intent.id,
      providerClientSecret: intent.client_secret || "",
    });

    // Keep Payment.providerPaymentId as PaymentIntent id for webhook lookup
    payment.providerPaymentId = intent.id;
    payment.providerClientSecret = intent.client_secret || "";
    await payment.save();

    res.json({
      success: true,
      data: {
        provider: "stripe" as const,
        plan,
        publishableKey: env.STRIPE_PUBLISHABLE_KEY,
        clientSecret: intent.client_secret,
        paymentIntentId: intent.id,
        amountMinor: plan.totalMinor,
        currency: plan.currency,
        paymentId: payment._id.toString(),
        campaignId: campaign._id.toString(),
      },
    });
  }),
);

const razorpayVerifySchema = z.object({
  orderId: z.string().min(1),
  paymentId: z.string().min(1),
  signature: z.string().min(1),
});

boostRouter.post(
  "/verify/razorpay",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = razorpayVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR");
    }
    const result = await confirmRazorpayPayment(parsed.data);
    res.json({
      success: true,
      data: {
        paymentId: result.payment._id.toString(),
        campaignId: result.campaignId,
        status: result.status,
        already: result.already,
      },
    });
  }),
);

const stripeVerifySchema = z.object({
  paymentIntentId: z.string().min(1),
});

boostRouter.post(
  "/verify/stripe",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = stripeVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR");
    }
    const result = await confirmStripePaymentIntent(parsed.data.paymentIntentId);
    res.json({
      success: true,
      data: {
        paymentId: result.payment._id.toString(),
        campaignId: result.campaignId,
        status: result.status,
        already: result.already,
      },
    });
  }),
);
