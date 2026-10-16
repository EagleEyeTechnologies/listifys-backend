import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import type { CountryCode } from "../../types/domain.js";
import { logger } from "../../utils/logger.js";

export type PaymentProvider = "razorpay" | "stripe" | null;

/** Charge in the listing currency. The viewer's browse country must not send rupees to Stripe. */
export function paymentCountryForCharge(
  currency: string | null | undefined,
  listingCountry: string | null | undefined,
  viewerCountry: CountryCode,
): CountryCode {
  const code = String(currency || "")
    .trim()
    .toUpperCase();
  if (code === "INR") return "IN";
  if (code === "CAD") return "CA";
  if (code === "USD") return "US";
  const listing = String(listingCountry || "")
    .trim()
    .toUpperCase();
  if (listing === "IN" || listing === "US" || listing === "CA") return listing;
  return viewerCountry;
}

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

function razorpayHeaders() {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new AppError(503, "Razorpay not configured", "PAYMENTS_UNAVAILABLE");
  }
  const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64");
  return { Authorization: `Basic ${auth}`, "Content-Type": "application/json" };
}

function razorpayErrorDescription(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { description?: string } };
    return String(parsed.error?.description || "").trim();
  } catch {
    return "";
  }
}

type RazorpayPayment = { id: string; status: string; amount: number; currency: string };

export async function fetchRazorpayPayment(paymentId: string): Promise<RazorpayPayment | null> {
  const res = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: razorpayHeaders(),
  }).catch(() => null);
  if (!res?.ok) {
    logger.warn("Razorpay payment lookup failed", { paymentId, status: res?.status });
    return null;
  }
  return (await res.json()) as RazorpayPayment;
}

/** Settles an authorized payment. Uncaptured payments are auto-refunded by Razorpay after a few days. */
export async function captureRazorpayPayment(paymentId: string, amount: number, currency: string) {
  const res = await fetch(
    `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/capture`,
    {
      method: "POST",
      headers: razorpayHeaders(),
      body: JSON.stringify({ amount, currency }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error("Razorpay capture failed", { status: res.status, text, paymentId });
    const reason = razorpayErrorDescription(text);
    throw new AppError(
      502,
      reason ? `Razorpay could not capture the payment: ${reason}` : "Payment capture failed",
      "PAYMENT_ERROR",
    );
  }
  return (await res.json()) as RazorpayPayment;
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
  const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64");
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

function stripePaymentIntentError(status: number, text: string) {
  let message: string;
  let code: string;
  try {
    const body = JSON.parse(text) as { error?: { message?: string; code?: string } };
    message = String(body.error?.message || "").trim();
    code = String(body.error?.code || "");
  } catch {
    message = "";
    code = "";
  }
  if (status === 401 || code === "api_key_expired" || /invalid api key/i.test(message)) {
    return "Stripe rejected the API key. Check the secret key on the Stripe account, then update the server environment.";
  }
  if (
    code === "currency_not_supported" ||
    (/currency/i.test(message) && /not supported|invalid|cannot/i.test(message))
  ) {
    return message
      ? `Stripe could not start the payment: ${message} Enable that currency in the Stripe Dashboard.`
      : "Stripe could not start the payment because this currency is not enabled on the Stripe account.";
  }
  if (message) return `Stripe could not start the payment: ${message}`;
  return "Unable to create payment intent";
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
    throw new AppError(502, stripePaymentIntentError(res.status, text), "PAYMENT_ERROR");
  }
  return (await res.json()) as { id: string; client_secret: string };
}

/** Full refund of a captured payment. `providerPaymentId` is Razorpay `pay_…` or Stripe `pi_…`. */
export async function refundProviderPayment(input: {
  provider: string;
  providerPaymentId: string;
  amountMinor: number;
}) {
  if (!input.providerPaymentId) {
    throw new AppError(
      400,
      "This payment has no provider reference to refund",
      "REFUND_UNAVAILABLE",
    );
  }
  if (input.provider === "razorpay") {
    const current = await fetchRazorpayPayment(input.providerPaymentId);
    if (current?.status === "refunded") return { id: "already_refunded" };
    // Without auto-capture a paid ticket stays "authorized", and Razorpay refuses to refund it.
    if (current?.status === "authorized") {
      await captureRazorpayPayment(input.providerPaymentId, current.amount, current.currency);
    }
    const res = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(input.providerPaymentId)}/refund`,
      {
        method: "POST",
        headers: razorpayHeaders(),
        body: JSON.stringify({ amount: input.amountMinor }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error("Razorpay refund failed", {
        status: res.status,
        text,
        paymentId: input.providerPaymentId,
        paymentStatus: current?.status,
      });
      const reason = razorpayErrorDescription(text);
      throw new AppError(
        502,
        reason
          ? `Razorpay refused the refund: ${reason}`
          : "Refund failed at Razorpay. Try again later.",
        "REFUND_FAILED",
      );
    }
    return (await res.json()) as { id: string };
  }
  if (input.provider === "stripe") {
    if (!env.STRIPE_SECRET_KEY) {
      throw new AppError(503, "Stripe not configured", "PAYMENTS_UNAVAILABLE");
    }
    const params = new URLSearchParams();
    params.set("payment_intent", input.providerPaymentId);
    params.set("amount", String(input.amountMinor));
    const res = await fetch("https://api.stripe.com/v1/refunds", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error("Stripe refund failed", { status: res.status, text });
      throw new AppError(502, "Refund failed at Stripe. Try again later.", "REFUND_FAILED");
    }
    return (await res.json()) as { id: string };
  }
  throw new AppError(400, "Refunds are not supported for this payment", "REFUND_UNAVAILABLE");
}
