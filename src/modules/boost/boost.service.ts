import mongoose from "mongoose";
import { BoostCampaign } from "./boostCampaign.model.js";
import { Payment } from "../payments/payment.model.js";
import { Listing } from "../listings/listing.model.js";
import { AppError } from "../../utils/AppError.js";
import { logger } from "../../utils/logger.js";
import type { BoostPlanDto } from "./boost.plans.js";

export async function createPendingBoostCheckout(input: {
  userId: string;
  plan: BoostPlanDto;
  listingId: string;
  provider: "razorpay" | "stripe";
  providerOrderId?: string;
  providerClientSecret?: string;
  providerPaymentId?: string;
}) {
  if (!mongoose.isValidObjectId(input.listingId)) {
    throw new AppError(400, "Invalid listingId", "VALIDATION_ERROR");
  }

  const listing = await Listing.findById(input.listingId);
  if (!listing || listing.status === "removed") {
    throw new AppError(404, "Listing not found", "NOT_FOUND");
  }
  if (listing.seller.toString() !== input.userId) {
    throw new AppError(403, "You can only boost your own listings", "FORBIDDEN");
  }

  const campaign = await BoostCampaign.create({
    userId: input.userId,
    listingId: listing._id,
    listingTitle: listing.title,
    listingImage: listing.images?.[0] || "",
    planKey: input.plan.planKey,
    planDays: input.plan.days,
    status: "pending_payment",
    countryCode: input.plan.countryCode,
    currency: input.plan.currency,
    amountMinor: input.plan.amountMinor,
    taxMinor: input.plan.taxMinor,
    totalMinor: input.plan.totalMinor,
  });

  const payment = await Payment.create({
    userId: input.userId,
    purpose: "boost",
    campaignId: campaign._id,
    provider: input.provider,
    status: "pending",
    currency: input.plan.currency,
    countryCode: input.plan.countryCode,
    amountMinor: input.plan.amountMinor,
    taxMinor: input.plan.taxMinor,
    totalMinor: input.plan.totalMinor,
    planKey: input.plan.planKey,
    planDays: input.plan.days,
    listingId: listing._id,
    providerOrderId: input.providerOrderId || "",
    providerPaymentId: input.providerPaymentId || "",
    providerClientSecret: input.providerClientSecret || "",
    metadata: {},
  });

  campaign.paymentId = payment._id;
  await campaign.save();

  return { campaign, payment, listing };
}

export async function activateBoostFromPayment(paymentId: string) {
  const payment = await Payment.findById(paymentId);
  if (!payment) {
    throw new AppError(404, "Payment not found", "NOT_FOUND");
  }
  if (payment.status === "succeeded") {
    const existing = payment.campaignId
      ? await BoostCampaign.findById(payment.campaignId)
      : null;
    return { payment, campaign: existing, already: true as const };
  }

  payment.status = "succeeded";
  payment.succeededAt = new Date();
  await payment.save();

  let campaign = payment.campaignId
    ? await BoostCampaign.findById(payment.campaignId)
    : null;

  if (!campaign) {
    logger.warn("Payment succeeded without campaign", {
      paymentId: payment._id.toString(),
    });
    return { payment, campaign: null, already: false as const };
  }

  if (campaign.status !== "active") {
    const start = new Date();
    const end = new Date(start.getTime() + campaign.planDays * 86400000);
    campaign.status = "active";
    campaign.startAt = start;
    campaign.endAt = end;
    campaign.activatedAt = start;
    await campaign.save();
  }

  if (campaign.listingId) {
    await Listing.findByIdAndUpdate(campaign.listingId, {
      $set: { featured: true },
    });
  }

  logger.info("Boost activated", {
    campaignId: campaign._id.toString(),
    listingId: campaign.listingId?.toString(),
    planKey: campaign.planKey,
  });

  return { payment, campaign, already: false as const };
}

export async function markBoostRefunded(paymentId: string) {
  const payment = await Payment.findById(paymentId);
  if (!payment) return;
  payment.status = "refunded";
  payment.refundedAt = new Date();
  await payment.save();

  if (payment.campaignId) {
    const campaign = await BoostCampaign.findById(payment.campaignId);
    if (campaign) {
      campaign.status = "refunded";
      campaign.expiredAt = new Date();
      await campaign.save();
      if (campaign.listingId) {
        const otherActive = await BoostCampaign.exists({
          listingId: campaign.listingId,
          status: "active",
          _id: { $ne: campaign._id },
        });
        if (!otherActive) {
          await Listing.findByIdAndUpdate(campaign.listingId, {
            $set: { featured: false },
          });
        }
      }
    }
  }
}

/** Expire campaigns whose endAt has passed; clear featured when none remain. */
export async function expireDueCampaigns() {
  const now = new Date();
  const due = await BoostCampaign.find({
    status: "active",
    endAt: { $lte: now },
  }).limit(200);

  for (const campaign of due) {
    campaign.status = "expired";
    campaign.expiredAt = now;
    await campaign.save();
    if (campaign.listingId) {
      const otherActive = await BoostCampaign.exists({
        listingId: campaign.listingId,
        status: "active",
        _id: { $ne: campaign._id },
      });
      if (!otherActive) {
        await Listing.findByIdAndUpdate(campaign.listingId, {
          $set: { featured: false },
        });
      }
    }
  }
  return due.length;
}
