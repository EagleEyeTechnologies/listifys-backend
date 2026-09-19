import mongoose from "mongoose";
import { EventBooking } from "./eventBooking.model.js";
import { Payment } from "../payments/payment.model.js";
import { Listing } from "../listings/listing.model.js";
import { User } from "../users/user.model.js";
import { createNotification } from "../notifications/notification.service.js";
import { AppError } from "../../utils/AppError.js";
import { logger } from "../../utils/logger.js";
import { absolutizeMediaUrl } from "../../utils/mediaUrl.js";
import type { CountryCode } from "../../types/domain.js";

function currencySymbol(iso: string) {
  const c = iso.toUpperCase();
  if (c === "INR") return "₹";
  if (c === "CAD") return "C$";
  return "$";
}

function toMinorUnits(major: number) {
  if (!Number.isFinite(major) || major <= 0) return 0;
  return Math.round((major + Number.EPSILON) * 100);
}

function ticketsAvailableOf(listing: InstanceType<typeof Listing>) {
  const extras = (listing.extras || {}) as Record<string, unknown>;
  const event =
    extras.event && typeof extras.event === "object"
      ? (extras.event as Record<string, unknown>)
      : {};
  const raw = event.ticketsAvailable ?? extras.ticketsAvailable ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function findActiveEvent(listingId: string) {
  if (!mongoose.isValidObjectId(listingId)) {
    throw new AppError(400, "Invalid event id", "VALIDATION_ERROR");
  }
  const listing = await Listing.findById(listingId);
  if (!listing || listing.status === "removed" || listing.category !== "events") {
    throw new AppError(404, "Event listing not found", "NOT_FOUND");
  }
  if (listing.status !== "active") {
    throw new AppError(400, "This event is not available for booking", "EVENT_UNAVAILABLE");
  }
  return listing;
}

async function assertCanBook(
  listing: InstanceType<typeof Listing>,
  userId: string,
  qty: number,
) {
  if (listing.seller.toString() === userId) {
    throw new AppError(400, "You cannot book tickets for your own event", "FORBIDDEN");
  }
  const available = ticketsAvailableOf(listing);
  if (available > 0 && qty > available) {
    throw new AppError(
      400,
      `Only ${available} ticket(s) available`,
      "INSUFFICIENT_TICKETS",
    );
  }
  return listing.seller.toString();
}

async function decrementTickets(listingId: mongoose.Types.ObjectId, qty: number) {
  const listing = await Listing.findById(listingId).select("extras");
  if (!listing) throw new AppError(404, "Event not found", "NOT_FOUND");

  const available = ticketsAvailableOf(listing);
  if (available <= 0) return; // unlimited

  // Ensure nested path exists so $inc works
  const extras = (listing.extras || {}) as Record<string, unknown>;
  const event =
    extras.event && typeof extras.event === "object"
      ? (extras.event as Record<string, unknown>)
      : {};
  if (typeof event.ticketsAvailable !== "number") {
    await Listing.findByIdAndUpdate(listingId, {
      $set: { "extras.event.ticketsAvailable": available },
    });
  }

  const updated = await Listing.findOneAndUpdate(
    { _id: listingId, "extras.event.ticketsAvailable": { $gte: qty } },
    { $inc: { "extras.event.ticketsAvailable": -qty } },
    { new: true },
  );
  if (!updated) {
    throw new AppError(409, "Not enough tickets left", "INSUFFICIENT_TICKETS");
  }
}

async function notifyConfirmed(
  listing: InstanceType<typeof Listing>,
  booking: InstanceType<typeof EventBooking>,
) {
  const qty = booking.ticketQuantity;
  const ticketLabel = `${qty} ticket${qty === 1 ? "" : "s"}`;
  const image = listing.images?.[0] || "";
  try {
    await createNotification({
      userId: booking.userId.toString(),
      type: "listing",
      title: "Tickets confirmed",
      body: `Your booking for "${listing.title}" is confirmed (${ticketLabel}).`,
      href: `/event-tickets/${booking._id.toString()}`,
      image,
    });
    if (booking.sellerId.toString() !== booking.userId.toString()) {
      await createNotification({
        userId: booking.sellerId.toString(),
        type: "listing",
        title: "New ticket booking",
        body: `${booking.attendeeName || "Someone"} booked ${ticketLabel} for "${listing.title}".`,
        href: `/events/${listing._id.toString()}/bookings`,
        image,
      });
    }
  } catch (err) {
    logger.warn("Event ticket notification failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function confirmBooking(
  booking: InstanceType<typeof EventBooking>,
  listing: InstanceType<typeof Listing>,
) {
  if (booking.status === "confirmed") return booking;

  await decrementTickets(listing._id, booking.ticketQuantity);
  booking.status = "confirmed";
  booking.confirmedAt = new Date();
  await booking.save();
  await notifyConfirmed(listing, booking);
  return booking;
}

export function serializeBooking(
  doc: InstanceType<typeof EventBooking>,
  extras?: {
    eventImage?: string;
    venue?: string;
    eventDate?: string;
    eventTime?: string;
  },
) {
  return {
    id: doc._id.toString(),
    listingId: doc.listingId.toString(),
    userId: doc.userId.toString(),
    sellerId: doc.sellerId.toString(),
    paymentId: doc.paymentId ? doc.paymentId.toString() : null,
    ticketQuantity: doc.ticketQuantity,
    unitPrice: doc.unitPrice,
    totalAmount: doc.totalAmount,
    currency: doc.currency,
    currencySymbol: doc.currencySymbol,
    countryCode: doc.countryCode,
    attendeeName: doc.attendeeName,
    attendeePhone: doc.attendeePhone,
    notes: doc.notes,
    eventTitle: doc.eventTitle,
    eventImage: extras?.eventImage || "",
    venue: extras?.venue || "",
    eventDate: extras?.eventDate || "",
    eventTime: extras?.eventTime || "",
    status: doc.status,
    isFree: doc.isFree,
    confirmedAt: doc.confirmedAt?.toISOString?.() || null,
  };
}

async function enrichBooking(doc: InstanceType<typeof EventBooking>) {
  const listing = await Listing.findById(doc.listingId)
    .select("images title location venue extras")
    .lean();
  const event =
    listing?.extras &&
    typeof listing.extras === "object" &&
    (listing.extras as { event?: Record<string, unknown> }).event
      ? ((listing.extras as { event: Record<string, unknown> }).event as Record<
          string,
          unknown
        >)
      : {};
  return serializeBooking(doc, {
    eventImage: absolutizeMediaUrl(
      Array.isArray(listing?.images) ? String(listing.images[0] || "") : "",
    ),
    venue: String(
      event.venue ||
        (listing as { venue?: string } | null)?.venue ||
        listing?.location ||
        "",
    ),
    eventDate: event.date ? String(event.date) : event.eventDate ? String(event.eventDate) : "",
    eventTime: event.time ? String(event.time) : event.eventTime ? String(event.eventTime) : "",
  });
}

export async function confirmFreeBooking(input: {
  userId: string;
  listingId: string;
  ticketQuantity: number;
  attendeeName?: string;
  attendeePhone?: string;
  notes?: string;
}) {
  const qty = Number(input.ticketQuantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 50) {
    throw new AppError(400, "Invalid ticket quantity", "VALIDATION_ERROR");
  }

  const listing = await findActiveEvent(input.listingId);
  const unitPrice = Number(listing.price || 0);
  if (unitPrice > 0) {
    throw new AppError(
      400,
      "This event requires payment. Use checkout.",
      "PAYMENT_REQUIRED",
    );
  }

  const sellerId = await assertCanBook(listing, input.userId, qty);
  const user = await User.findById(input.userId).select("name phone");

  const booking = await EventBooking.create({
    listingId: listing._id,
    userId: input.userId,
    sellerId,
    ticketQuantity: qty,
    unitPrice: 0,
    totalAmount: 0,
    currencySymbol: currencySymbol(listing.currency || "USD"),
    currency: (listing.currency || "USD").toUpperCase(),
    countryCode: listing.countryCode,
    attendeeName: input.attendeeName?.trim() || user?.name || "",
    attendeePhone: input.attendeePhone?.trim() || user?.phone || "",
    notes: input.notes?.trim() || "",
    eventTitle: listing.title || "",
    status: "pending_payment",
    isFree: true,
  });

  await confirmBooking(booking, listing);
  return { booking, free: true as const };
}

export async function createPendingTicketCheckout(input: {
  userId: string;
  listingId: string;
  ticketQuantity: number;
  attendeeName?: string;
  attendeePhone?: string;
  notes?: string;
  countryCode: CountryCode;
  provider: "razorpay" | "stripe";
  providerOrderId?: string;
  providerClientSecret?: string;
  providerPaymentId?: string;
}): Promise<
  | { booking: InstanceType<typeof EventBooking>; free: true }
  | {
      booking: InstanceType<typeof EventBooking>;
      payment: InstanceType<typeof Payment>;
      listing: InstanceType<typeof Listing>;
      free: false;
    }
> {
  const qty = Number(input.ticketQuantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 50) {
    throw new AppError(400, "Invalid ticket quantity", "VALIDATION_ERROR");
  }

  const listing = await findActiveEvent(input.listingId);
  const unitPrice = Number(listing.price || 0);
  if (unitPrice <= 0) {
    return confirmFreeBooking({
      userId: input.userId,
      listingId: input.listingId,
      ticketQuantity: qty,
      attendeeName: input.attendeeName,
      attendeePhone: input.attendeePhone,
      notes: input.notes,
    });
  }

  const sellerId = await assertCanBook(listing, input.userId, qty);
  const user = await User.findById(input.userId).select("name phone");
  const currency = (listing.currency || "USD").toUpperCase();
  const totalMajor = unitPrice * qty;
  const amountMinor = toMinorUnits(totalMajor);
  const minMinor = currency === "INR" || input.provider === "razorpay" ? 100 : 50;
  if (amountMinor > 0 && amountMinor < minMinor) {
    throw new AppError(
      400,
      currency === "INR"
        ? "Ticket price is below the ₹1.00 payment minimum"
        : "Ticket price is below the $0.50 payment minimum",
      "AMOUNT_TOO_SMALL",
    );
  }

  const booking = await EventBooking.create({
    listingId: listing._id,
    userId: input.userId,
    sellerId,
    ticketQuantity: qty,
    unitPrice,
    totalAmount: totalMajor,
    currencySymbol: currencySymbol(currency),
    currency,
    countryCode: input.countryCode,
    attendeeName: input.attendeeName?.trim() || user?.name || "",
    attendeePhone: input.attendeePhone?.trim() || user?.phone || "",
    notes: input.notes?.trim() || "",
    eventTitle: listing.title || "",
    status: "pending_payment",
    isFree: false,
  });

  const payment = await Payment.create({
    userId: input.userId,
    purpose: "event_ticket",
    eventBookingId: booking._id,
    provider: input.provider,
    status: "pending",
    currency,
    countryCode: input.countryCode,
    amountMinor,
    taxMinor: 0,
    totalMinor: amountMinor,
    planKey: "event_ticket",
    planDays: 1,
    listingId: listing._id,
    providerOrderId: input.providerOrderId || "",
    providerPaymentId: input.providerPaymentId || "",
    providerClientSecret: input.providerClientSecret || "",
    metadata: { ticketQuantity: qty },
  });

  booking.paymentId = payment._id;
  await booking.save();

  return { booking, payment, listing, free: false };
}

export async function activateEventBookingFromPayment(paymentId: string) {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw new AppError(404, "Payment not found", "NOT_FOUND");

  if (payment.status === "succeeded") {
    const existing = payment.eventBookingId
      ? await EventBooking.findById(payment.eventBookingId)
      : null;
    return { payment, booking: existing, already: true as const };
  }

  payment.status = "succeeded";
  payment.succeededAt = new Date();
  await payment.save();

  const booking = payment.eventBookingId
    ? await EventBooking.findById(payment.eventBookingId)
    : null;

  if (!booking) {
    logger.warn("Event ticket payment succeeded without booking", {
      paymentId: payment._id.toString(),
    });
    return { payment, booking: null, already: false as const };
  }

  const listing = await Listing.findById(booking.listingId);
  if (!listing) {
    throw new AppError(404, "Event listing not found", "NOT_FOUND");
  }

  await confirmBooking(booking, listing);
  return { payment, booking, already: false as const };
}

export async function markEventTicketRefunded(paymentId: string) {
  const payment = await Payment.findById(paymentId);
  if (!payment) return;
  payment.status = "refunded";
  payment.refundedAt = new Date();
  await payment.save();

  if (!payment.eventBookingId) return;
  const booking = await EventBooking.findById(payment.eventBookingId);
  if (!booking || booking.status === "refunded") return;

  booking.status = "refunded";
  booking.cancelledAt = new Date();
  await booking.save();

  const available = await Listing.findById(booking.listingId).select("extras");
  if (available && ticketsAvailableOf(available) > 0) {
    await Listing.findByIdAndUpdate(booking.listingId, {
      $inc: { "extras.event.ticketsAvailable": booking.ticketQuantity },
    });
  }
}

export async function getMyBookings(userId: string) {
  const rows = await EventBooking.find({ userId })
    .sort({ createdAt: -1 })
    .limit(50);
  return Promise.all(rows.map((row) => enrichBooking(row)));
}

export async function getBookingForUser(bookingId: string, userId: string) {
  if (!mongoose.isValidObjectId(bookingId)) {
    throw new AppError(400, "Invalid booking id", "VALIDATION_ERROR");
  }
  const booking = await EventBooking.findById(bookingId);
  if (!booking) throw new AppError(404, "Booking not found", "NOT_FOUND");
  if (
    booking.userId.toString() !== userId &&
    booking.sellerId.toString() !== userId
  ) {
    throw new AppError(403, "Not allowed to view this booking", "FORBIDDEN");
  }
  return enrichBooking(booking);
}

export async function getOrganizerBookings(listingId: string, userId: string) {
  const listing = await findActiveEvent(listingId).catch(async () => {
    if (!mongoose.isValidObjectId(listingId)) {
      throw new AppError(400, "Invalid event id", "VALIDATION_ERROR");
    }
    const row = await Listing.findById(listingId);
    if (!row || row.category !== "events") {
      throw new AppError(404, "Event listing not found", "NOT_FOUND");
    }
    return row;
  });
  if (listing.seller.toString() !== userId) {
    throw new AppError(403, "Only the organizer can view bookings", "FORBIDDEN");
  }
  const rows = await EventBooking.find({
    listingId: listing._id,
    status: { $in: ["confirmed", "refunded", "withdraw_requested"] },
  })
    .sort({ createdAt: -1 })
    .limit(200);
  return Promise.all(rows.map((row) => enrichBooking(row)));
}

export async function requestBookingWithdrawal(input: {
  userId: string;
  bookingId: string;
  reason?: string;
}) {
  if (!mongoose.isValidObjectId(input.bookingId)) {
    throw new AppError(400, "Invalid booking id", "VALIDATION_ERROR");
  }
  const booking = await EventBooking.findById(input.bookingId);
  if (!booking || booking.userId.toString() !== input.userId) {
    throw new AppError(404, "Booking not found", "NOT_FOUND");
  }
  if (!["confirmed", "withdraw_requested"].includes(booking.status)) {
    throw new AppError(
      400,
      "This booking cannot be withdrawn",
      "VALIDATION_ERROR",
    );
  }
  if (booking.status === "withdraw_requested") {
    return enrichBooking(booking);
  }

  const listing = await Listing.findById(booking.listingId);
  const isFree = booking.isFree || Number(booking.totalAmount) <= 0;
  booking.status = isFree ? "cancelled" : "withdraw_requested";
  booking.cancelledAt = new Date();
  booking.metadata = {
    ...(booking.metadata && typeof booking.metadata === "object"
      ? (booking.metadata as Record<string, unknown>)
      : {}),
    withdrawReason: String(input.reason || "").trim(),
    withdrawRequestedAt: new Date().toISOString(),
  };
  await booking.save();

  if (listing && booking.ticketQuantity > 0) {
    await Listing.findByIdAndUpdate(listing._id, {
      $inc: { "extras.event.ticketsAvailable": booking.ticketQuantity },
    });
  }

  const title = listing?.title || booking.eventTitle || "the event";
  const qty = booking.ticketQuantity;
  const image = absolutizeMediaUrl(
    Array.isArray(listing?.images) ? String(listing.images[0] || "") : "",
  );

  try {
    if (booking.sellerId.toString() !== booking.userId.toString()) {
      await createNotification({
        userId: booking.sellerId.toString(),
        type: "listing",
        title: "Ticket withdrawal request",
        body: `${booking.attendeeName || "A guest"} requested withdrawal of ${qty} ticket${qty === 1 ? "" : "s"} for "${title}".`,
        href: `/events/${booking.listingId.toString()}`,
        image,
      });
    }
    await createNotification({
      userId: booking.userId.toString(),
      type: "listing",
      title: isFree ? "Tickets cancelled" : "Withdrawal requested",
      body: isFree
        ? `Your tickets for "${title}" were cancelled.`
        : `Your withdrawal request for "${title}" was sent to the organizer.`,
      href: `/event-tickets/${booking._id.toString()}`,
      image,
    });
  } catch (err) {
    logger.warn("Withdrawal notification failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return enrichBooking(booking);
}
