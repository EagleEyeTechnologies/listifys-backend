import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../../config/env.js";
import { Payment } from "./payment.model.js";
import { WebhookEvent } from "./webhookEvent.model.js";
import { activateForPayment, refundForPayment } from "./activatePayment.js";
import { logger } from "../../utils/logger.js";
import { AppError } from "../../utils/AppError.js";

function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function verifyRazorpaySignature(input: {
  orderId: string;
  paymentId: string;
  signature: string;
}) {
  if (!env.RAZORPAY_KEY_SECRET) return false;
  const body = `${input.orderId}|${input.paymentId}`;
  const expected = createHmac("sha256", env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest("hex");
  return safeEqual(expected, input.signature);
}

export async function confirmRazorpayPayment(input: {
  orderId: string;
  paymentId: string;
  signature: string;
}) {
  if (
    !verifyRazorpaySignature({
      orderId: input.orderId,
      paymentId: input.paymentId,
      signature: input.signature,
    })
  ) {
    throw new AppError(400, "Invalid payment signature", "INVALID_SIGNATURE");
  }

  const payment = await Payment.findOne({
    provider: "razorpay",
    providerOrderId: input.orderId,
  });
  if (!payment) {
    throw new AppError(404, "Payment not found", "NOT_FOUND");
  }

  payment.providerPaymentId = input.paymentId;
  await payment.save();
  return activateForPayment(payment._id.toString());
}

async function recordWebhook(input: {
  provider: "razorpay" | "stripe";
  providerEventId: string;
  eventType: string;
  payload: unknown;
}) {
  try {
    await WebhookEvent.create({
      provider: input.provider,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      payload: input.payload,
      processed: false,
    });
    return { duplicate: false };
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      return { duplicate: true };
    }
    throw err;
  }
}

export async function handleRazorpayWebhook(rawBody: Buffer, signature: string) {
  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    throw new AppError(
      503,
      "Razorpay webhook not configured",
      "WEBHOOK_UNAVAILABLE",
    );
  }
  const expected = createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  if (!safeEqual(expected, signature)) {
    throw new AppError(400, "Invalid webhook signature", "INVALID_SIGNATURE");
  }

  const payload = JSON.parse(rawBody.toString("utf8")) as {
    event?: string;
    payload?: {
      payment?: { entity?: { id?: string; order_id?: string; status?: string } };
      order?: { entity?: { id?: string } };
    };
  };

  const event = payload.event || "";
  const entity = payload.payload?.payment?.entity;
  const orderId = entity?.order_id || payload.payload?.order?.entity?.id || "";
  const paymentId = entity?.id || "";
  const eventId = `${event}:${paymentId || orderId || Date.now()}`;

  const recorded = await recordWebhook({
    provider: "razorpay",
    providerEventId: eventId,
    eventType: event,
    payload,
  });
  if (recorded.duplicate) {
    return { duplicate: true, event };
  }

  if (!orderId) {
    await WebhookEvent.updateOne(
      { provider: "razorpay", providerEventId: eventId },
      { $set: { processed: true, processedAt: new Date() } },
    );
    return { ignored: true, event };
  }

  const payment = await Payment.findOne({
    provider: "razorpay",
    providerOrderId: orderId,
  });
  if (!payment) {
    logger.warn("Razorpay webhook: payment missing", { orderId, event });
    await WebhookEvent.updateOne(
      { provider: "razorpay", providerEventId: eventId },
      { $set: { processed: true, processedAt: new Date(), error: "payment_missing" } },
    );
    return { ignored: true, event };
  }

  if (paymentId) {
    payment.providerPaymentId = paymentId;
    await payment.save();
  }

  try {
    if (
      event === "payment.captured" ||
      event === "order.paid" ||
      entity?.status === "captured"
    ) {
      await activateForPayment(payment._id.toString());
    } else if (event === "refund.processed") {
      await refundForPayment(payment._id.toString());
    } else if (event === "payment.failed") {
      payment.status = "failed";
      await payment.save();
    }
    await WebhookEvent.updateOne(
      { provider: "razorpay", providerEventId: eventId },
      { $set: { processed: true, processedAt: new Date() } },
    );
  } catch (err) {
    await WebhookEvent.updateOne(
      { provider: "razorpay", providerEventId: eventId },
      {
        $set: {
          error: err instanceof Error ? err.message : String(err),
        },
      },
    );
    throw err;
  }

  return { ok: true, event };
}

export async function handleStripeWebhook(rawBody: Buffer, signature: string) {
  if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY) {
    throw new AppError(
      503,
      "Stripe webhook not configured",
      "WEBHOOK_UNAVAILABLE",
    );
  }

  const parts = Object.fromEntries(
    signature.split(",").map((p) => {
      const [k, v] = p.split("=");
      return [k, v];
    }),
  ) as { t?: string; v1?: string };
  if (!parts.t || !parts.v1) {
    throw new AppError(400, "Invalid Stripe signature header", "INVALID_SIGNATURE");
  }
  const signed = `${parts.t}.${rawBody.toString("utf8")}`;
  const expected = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET)
    .update(signed)
    .digest("hex");
  if (!safeEqual(expected, parts.v1)) {
    throw new AppError(400, "Invalid Stripe signature", "INVALID_SIGNATURE");
  }

  const event = JSON.parse(rawBody.toString("utf8")) as {
    id?: string;
    type?: string;
    data?: { object?: { id?: string; metadata?: Record<string, string> } };
  };

  const type = event.type || "";
  const obj = event.data?.object;
  const intentId = obj?.id || "";
  const eventId = event.id || `${type}:${intentId || Date.now()}`;

  const recorded = await recordWebhook({
    provider: "stripe",
    providerEventId: eventId,
    eventType: type,
    payload: event,
  });
  if (recorded.duplicate) {
    return { duplicate: true, type };
  }

  if (!intentId) {
    await WebhookEvent.updateOne(
      { provider: "stripe", providerEventId: eventId },
      { $set: { processed: true, processedAt: new Date() } },
    );
    return { ignored: true, type };
  }

  const payment = await Payment.findOne({
    provider: "stripe",
    providerPaymentId: intentId,
  });
  if (!payment) {
    logger.warn("Stripe webhook: payment missing", { intentId, type });
    await WebhookEvent.updateOne(
      { provider: "stripe", providerEventId: eventId },
      { $set: { processed: true, processedAt: new Date(), error: "payment_missing" } },
    );
    return { ignored: true, type };
  }

  try {
    if (type === "payment_intent.succeeded") {
      await activateForPayment(payment._id.toString());
    } else if (type === "payment_intent.payment_failed") {
      payment.status = "failed";
      await payment.save();
    } else if (type === "charge.refunded") {
      await refundForPayment(payment._id.toString());
    }
    await WebhookEvent.updateOne(
      { provider: "stripe", providerEventId: eventId },
      { $set: { processed: true, processedAt: new Date() } },
    );
  } catch (err) {
    await WebhookEvent.updateOne(
      { provider: "stripe", providerEventId: eventId },
      {
        $set: {
          error: err instanceof Error ? err.message : String(err),
        },
      },
    );
    throw err;
  }

  return { ok: true, type };
}

export async function confirmStripePaymentIntent(paymentIntentId: string) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new AppError(503, "Stripe not configured", "PAYMENTS_UNAVAILABLE");
  }
  const res = await fetch(
    `https://api.stripe.com/v1/payment_intents/${paymentIntentId}`,
    {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    },
  );
  if (!res.ok) {
    throw new AppError(502, "Unable to fetch payment intent", "PAYMENT_ERROR");
  }
  const intent = (await res.json()) as { id: string; status: string };
  if (intent.status !== "succeeded") {
    throw new AppError(
      400,
      `Payment not completed (${intent.status})`,
      "PAYMENT_PENDING",
    );
  }

  const payment = await Payment.findOne({
    provider: "stripe",
    providerPaymentId: intent.id,
  });
  if (!payment) {
    throw new AppError(404, "Payment not found", "NOT_FOUND");
  }
  return activateForPayment(payment._id.toString());
}
