import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../utils/AppError.js";
import { env } from "../../config/env.js";
import {
  formatPremiumMinor,
  getPremiumPlan,
} from "./premium.plans.js";
import {
  createPendingPremiumCheckout,
  expireDuePremium,
  getPremiumStatus,
  startPremiumTrial,
} from "./premium.service.js";
import {
  createRazorpayOrder,
  createStripePaymentIntent,
  paymentConfigFor,
} from "../payments/payments.service.js";
import {
  confirmRazorpayPayment,
  confirmStripePaymentIntent,
} from "../payments/payments.webhooks.js";

export const premiumRouter = Router();

premiumRouter.get(
  "/plan",
  asyncHandler(async (req, res) => {
    const plan = getPremiumPlan(req.countryCode);
    res.json({
      success: true,
      data: {
        plan: {
          ...plan,
          amountDisplay: formatPremiumMinor(plan.amountMinor, plan.currency),
          taxDisplay: formatPremiumMinor(plan.taxMinor, plan.currency),
          totalDisplay: formatPremiumMinor(plan.totalMinor, plan.currency),
        },
        payments: paymentConfigFor(req.countryCode),
      },
    });
  }),
);

premiumRouter.get(
  "/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    await expireDuePremium();
    const status = await getPremiumStatus(String(req.userId));
    res.json({ success: true, data: status });
  }),
);

premiumRouter.post(
  "/trial",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await startPremiumTrial(String(req.userId), req.countryCode);
    res.json({
      success: true,
      data: {
        status: result.status,
        subscriptionId: result.subscription._id.toString(),
      },
    });
  }),
);

premiumRouter.post(
  "/checkout",
  requireAuth,
  asyncHandler(async (req, res) => {
    const plan = getPremiumPlan(req.countryCode);
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
        receipt: `prem_${Date.now()}`,
        notes: {
          purpose: "premium_subscription",
          planKey: plan.planKey,
          userId: String(req.userId),
          countryCode: plan.countryCode,
        },
      });
      const { subscription, payment } = await createPendingPremiumCheckout({
        userId: String(req.userId),
        plan,
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
          subscriptionId: subscription._id.toString(),
        },
      });
      return;
    }

    const intent = await createStripePaymentIntent({
      amountMinor: plan.totalMinor,
      currency: plan.currency,
      metadata: {
        purpose: "premium_subscription",
        planKey: plan.planKey,
        userId: String(req.userId),
        countryCode: plan.countryCode,
      },
    });

    const { subscription, payment } = await createPendingPremiumCheckout({
      userId: String(req.userId),
      plan,
      provider: "stripe",
      providerPaymentId: intent.id,
      providerClientSecret: intent.client_secret || "",
    });
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
        subscriptionId: subscription._id.toString(),
      },
    });
  }),
);

const razorpayVerifySchema = z.object({
  orderId: z.string().min(1),
  paymentId: z.string().min(1),
  signature: z.string().min(1),
});

premiumRouter.post(
  "/verify/razorpay",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = razorpayVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR");
    }
    const result = await confirmRazorpayPayment(parsed.data);
    const status = await getPremiumStatus(String(req.userId));
    res.json({
      success: true,
      data: {
        status,
        paymentId: result.payment._id.toString(),
        already: result.already,
      },
    });
  }),
);

const stripeVerifySchema = z.object({
  paymentIntentId: z.string().min(1),
});

premiumRouter.post(
  "/verify/stripe",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = stripeVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR");
    }
    const result = await confirmStripePaymentIntent(parsed.data.paymentIntentId);
    const status = await getPremiumStatus(String(req.userId));
    res.json({
      success: true,
      data: {
        status,
        paymentId: result.payment._id.toString(),
        already: result.already,
      },
    });
  }),
);
