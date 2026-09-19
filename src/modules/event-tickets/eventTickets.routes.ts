import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../utils/AppError.js";
import { env } from "../../config/env.js";
import { Listing } from "../listings/listing.model.js";
import {
  confirmFreeBooking,
  createPendingTicketCheckout,
  getBookingForUser,
  getMyBookings,
  getOrganizerBookings,
  requestBookingWithdrawal,
  serializeBooking,
} from "./eventTickets.service.js";
import {
  createRazorpayOrder,
  createStripePaymentIntent,
  paymentConfigFor,
} from "../payments/payments.service.js";
import {
  confirmRazorpayPayment,
  confirmStripePaymentIntent,
} from "../payments/payments.webhooks.js";

export const eventTicketsRouter = Router();

const bookSchema = z.object({
  ticketQuantity: z.coerce.number().int().min(1).max(50),
  attendeeName: z.string().max(120).optional(),
  attendeePhone: z.string().max(40).optional(),
  notes: z.string().max(500).optional(),
});

eventTicketsRouter.get(
  "/my-bookings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const items = await getMyBookings(String(req.userId));
    res.json({ success: true, data: { items } });
  }),
);

eventTicketsRouter.get(
  "/my-bookings/:bookingId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const booking = await getBookingForUser(
      String(req.params.bookingId),
      String(req.userId),
    );
    res.json({ success: true, data: booking });
  }),
);

eventTicketsRouter.post(
  "/my-bookings/:bookingId/withdraw",
  requireAuth,
  asyncHandler(async (req, res) => {
    const booking = await requestBookingWithdrawal({
      userId: String(req.userId),
      bookingId: String(req.params.bookingId),
      reason:
        typeof req.body?.reason === "string" ? req.body.reason : undefined,
    });
    res.json({
      success: true,
      message: "Withdrawal request sent to the organizer.",
      data: booking,
    });
  }),
);

const razorpayVerifySchema = z.object({
  orderId: z.string().min(1),
  paymentId: z.string().min(1),
  signature: z.string().min(1),
});

eventTicketsRouter.post(
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
        bookingId: result.bookingId,
        status: result.status,
        already: result.already,
      },
    });
  }),
);

const stripeVerifySchema = z.object({
  paymentIntentId: z.string().min(1),
});

eventTicketsRouter.post(
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
        bookingId: result.bookingId,
        status: result.status,
        already: result.already,
      },
    });
  }),
);

eventTicketsRouter.get(
  "/:listingId/bookings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const items = await getOrganizerBookings(
      String(req.params.listingId),
      String(req.userId),
    );
    res.json({ success: true, data: { items } });
  }),
);

eventTicketsRouter.post(
  "/:listingId/book",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = bookSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR");
    }
    const listingId = String(req.params.listingId);
    const result = await confirmFreeBooking({
      userId: String(req.userId),
      listingId,
      ...parsed.data,
    });
    res.json({
      success: true,
      data: {
        free: true,
        booking: serializeBooking(result.booking),
      },
    });
  }),
);

eventTicketsRouter.post(
  "/:listingId/checkout",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = bookSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR");
    }

    const listingId = String(req.params.listingId);
    const listing = await Listing.findById(listingId).select(
      "price category status currency countryCode",
    );
    if (!listing || listing.category !== "events" || listing.status === "removed") {
      throw new AppError(404, "Event listing not found", "NOT_FOUND");
    }

    if (Number(listing.price || 0) <= 0) {
      const result = await confirmFreeBooking({
        userId: String(req.userId),
        listingId,
        ...parsed.data,
      });
      res.json({
        success: true,
        data: {
          free: true,
          booking: serializeBooking(result.booking),
        },
      });
      return;
    }

    const cfg = paymentConfigFor(req.countryCode);
    if (!cfg.provider) {
      throw new AppError(
        503,
        "Payments are not configured for this market yet",
        "PAYMENTS_UNAVAILABLE",
      );
    }

    const qty = parsed.data.ticketQuantity;
    const amountMinor = Math.round(Number(listing.price) * qty * 100);
    const currency = (listing.currency || "USD").toUpperCase();

    if (cfg.provider === "razorpay") {
      const order = await createRazorpayOrder({
        amountMinor,
        currency,
        receipt: `evt_${Date.now()}`.slice(0, 40),
        notes: {
          purpose: "event_ticket",
          listingId,
          userId: String(req.userId),
        },
      });
      const result = await createPendingTicketCheckout({
        userId: String(req.userId),
        listingId,
        ticketQuantity: qty,
        attendeeName: parsed.data.attendeeName,
        attendeePhone: parsed.data.attendeePhone,
        notes: parsed.data.notes,
        countryCode: req.countryCode,
        provider: "razorpay",
        providerOrderId: order.id,
      });
      if (result.free) {
        res.json({
          success: true,
          data: { free: true, booking: serializeBooking(result.booking) },
        });
        return;
      }
      res.json({
        success: true,
        data: {
          free: false,
          provider: "razorpay" as const,
          keyId: env.RAZORPAY_KEY_ID,
          orderId: order.id,
          amountMinor: result.payment.totalMinor,
          currency: result.payment.currency,
          paymentId: result.payment._id.toString(),
          bookingId: result.booking._id.toString(),
        },
      });
      return;
    }

    const intent = await createStripePaymentIntent({
      amountMinor,
      currency,
      metadata: {
        purpose: "event_ticket",
        listingId,
        userId: String(req.userId),
      },
    });
    const result = await createPendingTicketCheckout({
      userId: String(req.userId),
      listingId,
      ticketQuantity: qty,
      attendeeName: parsed.data.attendeeName,
      attendeePhone: parsed.data.attendeePhone,
      notes: parsed.data.notes,
      countryCode: req.countryCode,
      provider: "stripe",
      providerPaymentId: intent.id,
      providerClientSecret: intent.client_secret || "",
    });
    if (result.free) {
      res.json({
        success: true,
        data: { free: true, booking: serializeBooking(result.booking) },
      });
      return;
    }
    result.payment.providerPaymentId = intent.id;
    result.payment.providerClientSecret = intent.client_secret || "";
    await result.payment.save();

    res.json({
      success: true,
      data: {
        free: false,
        provider: "stripe" as const,
        publishableKey: env.STRIPE_PUBLISHABLE_KEY,
        clientSecret: intent.client_secret,
        paymentIntentId: intent.id,
        amountMinor: result.payment.totalMinor,
        currency: result.payment.currency,
        paymentId: result.payment._id.toString(),
        bookingId: result.booking._id.toString(),
      },
    });
  }),
);
