import { SellerSubscription } from "./sellerSubscription.model.js";
import { Payment } from "../payments/payment.model.js";
import { User } from "../users/user.model.js";
import { AppError } from "../../utils/AppError.js";
import { logger } from "../../utils/logger.js";
import { getPremiumPlan, type PremiumPlanDto } from "./premium.plans.js";
import type { CountryCode } from "../../types/domain.js";

function isActiveStatus(status: string) {
  return status === "trialing" || status === "active";
}

async function syncUserPremium(userId: string, patch: Record<string, unknown>) {
  await User.updateOne(
    { _id: userId },
    {
      $set: Object.fromEntries(Object.entries(patch).map(([k, v]) => [`sellerPremium.${k}`, v])),
    },
  );
}

export function publicPremiumStatus(user: InstanceType<typeof User> | null) {
  const sp = (user as { sellerPremium?: Record<string, unknown> } | null)?.sellerPremium || {};
  const status = String(sp.status || "none");
  const active = isActiveStatus(status);
  return {
    status,
    active,
    isPremiumSeller: Boolean(sp.isPremiumSeller) && active,
    planKey: String(sp.planKey || ""),
    trialEndsAt: sp.trialEndsAt || null,
    currentPeriodStart: sp.currentPeriodStart || null,
    currentPeriodEnd: sp.currentPeriodEnd || null,
    cancelAtPeriodEnd: Boolean(sp.cancelAtPeriodEnd),
    trialUsed: Boolean(sp.trialUsed),
    freeBoostsRemaining: Number(sp.freeBoostsRemaining || 0),
    freeBoostsPerMonth: Number(sp.freeBoostsPerMonth || 3),
    subscriptionId: sp.subscriptionId ? String(sp.subscriptionId) : null,
    provider: String(sp.provider || ""),
  };
}

export async function getPremiumStatus(userId: string) {
  const user = await User.findById(userId);
  return publicPremiumStatus(user);
}

export async function startPremiumTrial(userId: string, countryCode: CountryCode) {
  const user = await User.findById(userId);
  if (!user) throw new AppError(404, "User not found", "NOT_FOUND");

  const current = publicPremiumStatus(user);
  if (current.active) {
    throw new AppError(409, "You already have an active Premium membership", "ALREADY_PREMIUM");
  }
  if (current.trialUsed) {
    throw new AppError(409, "Free trial already used. Please subscribe.", "TRIAL_USED");
  }

  const plan = getPremiumPlan(countryCode);
  const start = new Date();
  const trialEnds = new Date(start.getTime() + plan.trialDays * 86400000);

  const sub = await SellerSubscription.create({
    userId,
    planKey: plan.planKey,
    status: "trialing",
    countryCode: plan.countryCode,
    currency: plan.currency,
    amountMinor: 0,
    taxMinor: 0,
    totalMinor: 0,
    trialDays: plan.trialDays,
    periodDays: plan.days,
    trialEndsAt: trialEnds,
    currentPeriodStart: start,
    currentPeriodEnd: trialEnds,
    activatedAt: start,
    provider: "",
    freeBoostsPerMonth: plan.freeBoostsPerMonth,
    freeBoostsRemaining: plan.freeBoostsPerMonth,
  });

  await syncUserPremium(userId, {
    status: "trialing",
    isPremiumSeller: true,
    planKey: plan.planKey,
    trialEndsAt: trialEnds,
    currentPeriodStart: start,
    currentPeriodEnd: trialEnds,
    cancelAtPeriodEnd: false,
    trialUsed: true,
    freeBoostsRemaining: plan.freeBoostsPerMonth,
    freeBoostsPerMonth: plan.freeBoostsPerMonth,
    subscriptionId: sub._id,
    provider: "",
  });

  return { subscription: sub, status: await getPremiumStatus(userId) };
}

export async function createPendingPremiumCheckout(input: {
  userId: string;
  plan: PremiumPlanDto;
  provider: "razorpay" | "stripe";
  providerOrderId?: string;
  providerPaymentId?: string;
  providerClientSecret?: string;
}) {
  const current = await getPremiumStatus(input.userId);
  if (current.active && current.status === "active") {
    throw new AppError(
      409,
      "You already have an active paid Premium membership",
      "ALREADY_PREMIUM",
    );
  }

  const sub = await SellerSubscription.create({
    userId: input.userId,
    planKey: input.plan.planKey,
    status: "pending_payment",
    countryCode: input.plan.countryCode,
    currency: input.plan.currency,
    amountMinor: input.plan.amountMinor,
    taxMinor: input.plan.taxMinor,
    totalMinor: input.plan.totalMinor,
    trialDays: input.plan.trialDays,
    periodDays: input.plan.days,
    provider: input.provider,
    freeBoostsPerMonth: input.plan.freeBoostsPerMonth,
    freeBoostsRemaining: input.plan.freeBoostsPerMonth,
  });

  const payment = await Payment.create({
    userId: input.userId,
    purpose: "premium_subscription",
    subscriptionId: sub._id,
    provider: input.provider,
    status: "pending",
    currency: input.plan.currency,
    countryCode: input.plan.countryCode,
    amountMinor: input.plan.amountMinor,
    taxMinor: input.plan.taxMinor,
    totalMinor: input.plan.totalMinor,
    planKey: input.plan.planKey,
    planDays: input.plan.days,
    providerOrderId: input.providerOrderId || "",
    providerPaymentId: input.providerPaymentId || "",
    providerClientSecret: input.providerClientSecret || "",
  });

  sub.paymentId = payment._id;
  await sub.save();
  return { subscription: sub, payment };
}

export async function activatePremiumFromPayment(paymentId: string) {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw new AppError(404, "Payment not found", "NOT_FOUND");

  if (payment.status === "succeeded") {
    const existing = payment.subscriptionId
      ? await SellerSubscription.findById(payment.subscriptionId)
      : null;
    return { payment, subscription: existing, already: true as const };
  }

  payment.status = "succeeded";
  payment.succeededAt = new Date();
  await payment.save();

  const sub = payment.subscriptionId
    ? await SellerSubscription.findById(payment.subscriptionId)
    : null;
  if (!sub) {
    logger.warn("Premium payment without subscription", {
      paymentId: payment._id.toString(),
    });
    return { payment, subscription: null, already: false as const };
  }

  const start = new Date();
  const end = new Date(start.getTime() + sub.periodDays * 86400000);
  sub.status = "active";
  sub.currentPeriodStart = start;
  sub.currentPeriodEnd = end;
  sub.activatedAt = start;
  sub.freeBoostsRemaining = sub.freeBoostsPerMonth;
  await sub.save();

  await syncUserPremium(sub.userId.toString(), {
    status: "active",
    isPremiumSeller: true,
    planKey: sub.planKey,
    trialEndsAt: sub.trialEndsAt || null,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    cancelAtPeriodEnd: false,
    trialUsed: true,
    freeBoostsRemaining: sub.freeBoostsPerMonth,
    freeBoostsPerMonth: sub.freeBoostsPerMonth,
    subscriptionId: sub._id,
    provider: payment.provider,
  });

  logger.info("Premium activated", {
    subscriptionId: sub._id.toString(),
    userId: sub.userId.toString(),
  });

  return { payment, subscription: sub, already: false as const };
}

export async function markPremiumRefunded(paymentId: string) {
  const payment = await Payment.findById(paymentId);
  if (!payment) return;
  payment.status = "refunded";
  payment.refundedAt = new Date();
  await payment.save();

  if (!payment.subscriptionId) return;
  const sub = await SellerSubscription.findById(payment.subscriptionId);
  if (!sub) return;
  sub.status = "refunded";
  await sub.save();
  await syncUserPremium(sub.userId.toString(), {
    status: "refunded",
    isPremiumSeller: false,
  });
}

export async function expireDuePremium() {
  const now = new Date();
  const due = await SellerSubscription.find({
    status: { $in: ["active", "trialing"] },
    currentPeriodEnd: { $lte: now },
  }).limit(200);

  for (const sub of due) {
    sub.status = "expired";
    await sub.save();
    await syncUserPremium(sub.userId.toString(), {
      status: "expired",
      isPremiumSeller: false,
    });
  }
  return due.length;
}
