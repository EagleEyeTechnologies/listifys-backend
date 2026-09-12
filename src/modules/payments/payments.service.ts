import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import type { CountryCode } from "../../types/domain.js";
import { logger } from "../../utils/logger.js";

export type PaymentProvider = "razorpay" | "stripe" | null;

export function paymentConfigFor(countryCode: CountryCode) {
  const razorpayReady =
    Boolean(env.RAZORPAY_ENABLED) &&
    Boolean(env.RAZORPAY_KEY_ID) &&
    Boolean(env.RAZORPAY_KEY_SECRET);
  const stripeReady =
    Boolean(env.STRIPE_ENABLED) &&
    Boolean(env.STRIPE_SECRET_KEY) &&
    Boolean(env.STRIPE_PUBLISHABLE_KEY);

  let provider: PaymentProvider = null;
  if (countryCode === "IN" && razorpayReady) provider = "razorpay";
  else if ((countryCode === "US" || countryCode === "CA") && stripeReady) {
    provider = "stripe";
  } else if (razorpayReady) provider = "razorpay";
  else if (stripeReady) provider = "stripe";

  return {
    provider,
    razorpayEnabled: razorpayReady,
    stripeEnabled: stripeReady,
    razorpayKeyId: razorpayReady ? env.RAZORPAY_KEY_ID : null,
    stripePublishableKey: stripeReady ? env.STRIPE_PUBLISHABLE_KEY : null,
  };
}

export async function createRazorpayOrder(input: {
  amountMinor: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
}) {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new AppError(503, "Razorpay not configured", "PAYMENTS_UNAVAILABLE");
  }
  const auth = Buffer.from(
    `${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`,
  ).toString("base64");
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: input.amountMinor,
      currency: input.currency,
      receipt: input.receipt.slice(0, 40),
      notes: input.notes,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error("Razorpay order failed", { status: res.status, text });
    throw new AppError(502, "Unable to create payment order", "PAYMENT_ERROR");
  }
  return (await res.json()) as { id: string };
}

export async function createStripePaymentIntent(input: {
  amountMinor: number;
  currency: string;
  metadata: Record<string, string>;
}) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new AppError(503, "Stripe not configured", "PAYMENTS_UNAVAILABLE");
  }
  const params = new URLSearchParams();
  params.set("amount", String(input.amountMinor));
  params.set("currency", input.currency.toLowerCase());
  params.set("automatic_payment_methods[enabled]", "true");
  for (const [k, v] of Object.entries(input.metadata)) {
    params.set(`metadata[${k}]`, v);
  }
  const res = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error("Stripe PaymentIntent failed", { status: res.status, text });
    throw new AppError(502, "Unable to create payment intent", "PAYMENT_ERROR");
  }
  return (await res.json()) as { id: string; client_secret: string };
}
