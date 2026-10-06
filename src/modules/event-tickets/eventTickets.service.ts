import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { EventBooking } from "./eventBooking.model.js";
import { Payment } from "../payments/payment.model.js";
import { Listing } from "../listings/listing.model.js";
import { User } from "../users/user.model.js";
import { createNotification } from "../notifications/notification.service.js";
import { refundProviderPayment } from "../payments/payments.service.js";
import { AppError } from "../../utils/AppError.js";
import { isEventPastFromExtras } from "./eventDate.js";
import { logger } from "../../utils/logger.js";
import { absolutizeMediaUrl } from "../../utils/mediaUrl.js";
import type { CountryCode } from "../../types/domain.js";
import {
  assertSeatsAvailable,
  computeInventory,
  resolveTicketPricing,
  syncEventInventory,
} from "./eventInventory.js";

type BookingDoc = InstanceType<typeof EventBooking>;
type ListingDoc = InstanceType<typeof Listing>;

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

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newTicketCode() {
  const bytes = randomBytes(8);
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `LST-${code}`;
}

export function ticketCodeOf(doc: BookingDoc) {
  return doc.ticketCode || `LST-${doc._id.toString().slice(-8).toUpperCase()}`;
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
  if (isEventPastFromExtras(listing.extras)) {
    throw new AppError(400, "This event has ended. Ticket booking is closed.", "EVENT_ENDED");
  }
  return listing;
}

/** Ticket price for this checkout. Exported so the checkout route charges the same amount. */
export async function quoteTickets(listingId: string, tierId: string | undefined, qty: number) {
  const listing = await findActiveEvent(listingId);
  const { tier, unitPrice } = resolveTicketPricing(listing, tierId);
  await assertSeatsAvailable(listing, tier?.id || null, qty);
  return { listing, tier, unitPrice, totalMajor: unitPrice * qty };
}

function assertNotOwnEvent(listing: ListingDoc, userId: string) {
  if (listing.seller.toString() === userId) {
    throw new AppError(400, "You cannot book tickets for your own event", "FORBIDDEN");
  }
  return listing.seller.toString();
}

async function notify(input: Parameters<typeof createNotification>[0]) {
  try {
    await createNotification(input);
  } catch (err) {
    logger.warn("Event ticket notification failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function ticketLabel(qty: number, tierName?: string) {
  const base = `${qty} ticket${qty === 1 ? "" : "s"}`;
  return tierName ? `${base} (${tierName})` : base;
}

async function notifyConfirmed(listing: ListingDoc, booking: BookingDoc) {
  const label = ticketLabel(booking.ticketQuantity, booking.ticketTierName || undefined);
  const image = listing.images?.[0] || "";
  await notify({
    userId: booking.userId.toString(),
    type: "listing",
    title: "Tickets confirmed",
    body: `Your booking for "${listing.title}" is confirmed (${label}). Ticket ID: ${ticketCodeOf(booking)}.`,
    href: `/event-tickets/${booking._id.toString()}`,
    image,
  });
  if (booking.sellerId.toString() !== booking.userId.toString()) {
    await notify({
      userId: booking.sellerId.toString(),
      type: "listing",
      title: "New ticket booking",
      body: `${booking.attendeeName || "Someone"} booked ${label} for "${listing.title}".`,
      href: `/events/${listing._id.toString()}/bookings`,
      image,
    });
  }
}

async function confirmBooking(booking: BookingDoc, listing: ListingDoc) {
  if (booking.status === "confirmed") return booking;
  booking.status = "confirmed";
  booking.confirmedAt = new Date();
  if (!booking.ticketCode) booking.ticketCode = newTicketCode();
  await booking.save();
  await syncEventInventory(listing._id);
  await notifyConfirmed(listing, booking);
  return booking;
}

export function serializeBooking(
  doc: BookingDoc,
  extras?: {
    eventImage?: string;
    venue?: string;
    eventDate?: string;
    eventTime?: string;
    startsAt?: string;
  },
) {
  const metadata =
    doc.metadata && typeof doc.metadata === "object"
      ? (doc.metadata as Record<string, unknown>)
      : {};
  return {
    id: doc._id.toString(),
    listingId: doc.listingId.toString(),
    userId: doc.userId.toString(),
    sellerId: doc.sellerId.toString(),
    paymentId: doc.paymentId ? doc.paymentId.toString() : null,
    ticketQuantity: doc.ticketQuantity,
    ticketTierId: doc.ticketTierId || "",
    ticketTierName: doc.ticketTierName || "",
    ticketCode: ticketCodeOf(doc),
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
    startsAt: extras?.startsAt || "",
    status: doc.status,
    isFree: doc.isFree,
    withdrawReason: typeof metadata.withdrawReason === "string" ? metadata.withdrawReason : "",
    cancelReason: typeof metadata.cancelReason === "string" ? metadata.cancelReason : "",
    cancelledBy: doc.cancelledBy || "",
    confirmedAt: doc.confirmedAt?.toISOString?.() || null,
    cancelledAt: doc.cancelledAt?.toISOString?.() || null,
    refundedAt: doc.refundedAt?.toISOString?.() || null,
    checkedInAt: doc.checkedInAt?.toISOString?.() || null,
    createdAt: (doc as BookingDoc & { createdAt?: Date }).createdAt?.toISOString?.() || null,
  };
}

async function enrichBooking(doc: BookingDoc) {
  const listing = await Listing.findById(doc.listingId)
    .select("images title location venue extras")
    .lean();
  const event =
    listing?.extras &&
    typeof listing.extras === "object" &&
    (listing.extras as { event?: Record<string, unknown> }).event
      ? ((listing.extras as { event: Record<string, unknown> }).event as Record<string, unknown>)
      : {};
  return serializeBooking(doc, {
    eventImage: absolutizeMediaUrl(
      Array.isArray(listing?.images) ? String(listing.images[0] || "") : "",
    ),
    venue: String(
      event.venue || (listing as { venue?: string } | null)?.venue || listing?.location || "",
    ),
    eventDate: event.date ? String(event.date) : event.eventDate ? String(event.eventDate) : "",
    eventTime: event.time ? String(event.time) : event.eventTime ? String(event.eventTime) : "",
    startsAt: event.startsAt ? String(event.startsAt) : "",
  });
}

type BookInput = {
  userId: string;
  listingId: string;
  ticketQuantity: number;
  ticketTierId?: string;
  attendeeName?: string;
  attendeePhone?: string;
  notes?: string;
};

function assertQty(raw: number) {
  const qty = Number(raw);
  if (!Number.isInteger(qty) || qty < 1 || qty > 50) {
    throw new AppError(400, "Invalid ticket quantity", "VALIDATION_ERROR");
  }
  return qty;
}

export async function confirmFreeBooking(input: BookInput) {
  const qty = assertQty(input.ticketQuantity);
  const { listing, tier, unitPrice } = await quoteTickets(input.listingId, input.ticketTierId, qty);
  if (unitPrice > 0) {
    throw new AppError(400, "This ticket requires payment. Use checkout.", "PAYMENT_REQUIRED");
  }
  const sellerId = assertNotOwnEvent(listing, input.userId);
  const user = await User.findById(input.userId).select("name phone");

  const booking = await EventBooking.create({
    listingId: listing._id,
    userId: input.userId,
    sellerId,
    ticketQuantity: qty,
    ticketTierId: tier?.id || "",
    ticketTierName: tier?.name || "",
    ticketCode: newTicketCode(),
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

export async function createPendingTicketCheckout(
  input: BookInput & {
    countryCode: CountryCode;
    provider: "razorpay" | "stripe";
    providerOrderId?: string;
    providerClientSecret?: string;
    providerPaymentId?: string;
  },
): Promise<
  | { booking: BookingDoc; free: true }
  | { booking: BookingDoc; payment: InstanceType<typeof Payment>; listing: ListingDoc; free: false }
> {
  const qty = assertQty(input.ticketQuantity);
  const { listing, tier, unitPrice, totalMajor } = await quoteTickets(
    input.listingId,
    input.ticketTierId,
    qty,
  );
  if (unitPrice <= 0) return confirmFreeBooking(input);

  await abandonPendingTicketCheckouts(input.userId, listing._id.toString());
  const sellerId = assertNotOwnEvent(listing, input.userId);
  const user = await User.findById(input.userId).select("name phone");
  const currency = (listing.currency || "USD").toUpperCase();
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
    ticketTierId: tier?.id || "",
    ticketTierName: tier?.name || "",
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
    metadata: { ticketQuantity: qty, ticketTierId: tier?.id || "" },
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

/** Webhook path: the provider reports a refund (ours or one issued from their dashboard). */
export async function markEventTicketRefunded(paymentId: string) {
  const payment = await Payment.findById(paymentId);
  if (!payment) return;
  if (payment.status !== "refunded") {
    payment.status = "refunded";
    payment.refundedAt = new Date();
    await payment.save();
  }

  if (!payment.eventBookingId) return;
  const booking = await EventBooking.findById(payment.eventBookingId);
  if (!booking || booking.status === "refunded") return;

  booking.status = "refunded";
  booking.refundedAt = new Date();
  booking.cancelledAt = booking.cancelledAt || new Date();
  await booking.save();
  await syncEventInventory(booking.listingId);
}

/** Drop unpaid checkouts so closing Razorpay does not leave Pending Payment rows. */
export async function abandonPendingTicketCheckouts(userId: string, listingId?: string) {
  const filter: Record<string, unknown> = { userId, status: "pending_payment" };
  if (listingId && mongoose.isValidObjectId(listingId)) filter.listingId = listingId;
  const rows = await EventBooking.find(filter).select("_id paymentId");
  if (!rows.length) return;
  const ids = rows.map((row) => row._id);
  const paymentIds = rows.map((row) => row.paymentId).filter(Boolean);
  await EventBooking.updateMany(
    { _id: { $in: ids }, status: "pending_payment" },
    { status: "cancelled", cancelledAt: new Date() },
  );
  if (paymentIds.length) {
    await Payment.updateMany(
      { _id: { $in: paymentIds }, status: { $in: ["created", "pending"] } },
      { status: "cancelled" },
    );
  }
}

export async function cancelPendingTicketBooking(userId: string, bookingId: string) {
  if (!mongoose.isValidObjectId(bookingId)) {
    throw new AppError(400, "Invalid booking id", "VALIDATION_ERROR");
  }
  const booking = await EventBooking.findById(bookingId);
  if (!booking || booking.userId.toString() !== userId) {
    throw new AppError(404, "Booking not found", "NOT_FOUND");
  }
  if (booking.status !== "pending_payment") return enrichBooking(booking);
  booking.status = "cancelled";
  booking.cancelledAt = new Date();
  await booking.save();
  if (booking.paymentId) {
    await Payment.updateOne(
      { _id: booking.paymentId, status: { $in: ["created", "pending"] } },
      { status: "cancelled" },
    );
  }
  return enrichBooking(booking);
}

export async function getMyBookings(userId: string) {
  const rows = await EventBooking.find({ userId }).sort({ createdAt: -1 }).limit(50);
  return Promise.all(rows.map((row) => enrichBooking(row)));
}

export async function getBookingForUser(bookingId: string, userId: string) {
  if (!mongoose.isValidObjectId(bookingId)) {
    throw new AppError(400, "Invalid booking id", "VALIDATION_ERROR");
  }
  const booking = await EventBooking.findById(bookingId);
  if (!booking) throw new AppError(404, "Booking not found", "NOT_FOUND");
  if (booking.userId.toString() !== userId && booking.sellerId.toString() !== userId) {
    throw new AppError(403, "Not allowed to view this booking", "FORBIDDEN");
  }
  return enrichBooking(booking);
}

async function organizerListing(listingId: string, userId: string) {
  if (!mongoose.isValidObjectId(listingId)) {
    throw new AppError(400, "Invalid event id", "VALIDATION_ERROR");
  }
  const listing = await Listing.findById(listingId);
  if (!listing || listing.status === "removed" || listing.category !== "events") {
    throw new AppError(404, "Event listing not found", "NOT_FOUND");
  }
  if (listing.seller.toString() !== userId) {
    throw new AppError(403, "Only the organizer can manage bookings", "FORBIDDEN");
  }
  return listing;
}

export async function getOrganizerBookings(listingId: string, userId: string) {
  const listing = await organizerListing(listingId, userId);
  const rows = await EventBooking.find({
    listingId: listing._id,
    $or: [
      { status: { $in: ["confirmed", "refunded", "withdraw_requested"] } },
      { status: "cancelled", confirmedAt: { $ne: null } },
    ],
  })
    .sort({ createdAt: -1 })
    .limit(500);
  const bookers = await User.find({ _id: { $in: [...new Set(rows.map((r) => r.userId))] } })
    .select("name email phone")
    .lean();
  const bookerById = new Map(bookers.map((u) => [String(u._id), u]));
  const items = rows.map((row) => {
    const booker = bookerById.get(row.userId.toString());
    const base = serializeBooking(row);
    return {
      ...base,
      attendeeName: base.attendeeName || booker?.name || "",
      attendeePhone: base.attendeePhone || booker?.phone || "",
      attendeeEmail: booker?.email || "",
    };
  });
  const inventory = await computeInventory(listing);
  const confirmed = rows.filter((r) => r.status === "confirmed");
  const summary = {
    eventTitle: listing.title,
    currency: (listing.currency || "USD").toUpperCase(),
    countryCode: listing.countryCode,
    ticketsTotal: inventory.total,
    ticketsSold: inventory.sold,
    ticketsAvailable: inventory.left,
    soldOut: inventory.soldOut,
    revenue: confirmed.reduce((sum, r) => sum + Number(r.totalAmount || 0), 0),
    refundedAmount: rows
      .filter((r) => r.status === "refunded")
      .reduce((sum, r) => sum + Number(r.totalAmount || 0), 0),
    bookings: confirmed.length,
    checkedIn: confirmed.filter((r) => r.checkedInAt).reduce((sum, r) => sum + r.ticketQuantity, 0),
    pendingWithdrawals: rows.filter((r) => r.status === "withdraw_requested").length,
    tiers: inventory.tiers.map((t) => ({
      id: t.id,
      name: t.name,
      price: t.price,
      quantity: t.quantity,
      sold: t.sold,
      left: t.left,
    })),
  };
  return { items, summary };
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
    throw new AppError(400, "This booking cannot be withdrawn", "VALIDATION_ERROR");
  }
  if (booking.status === "withdraw_requested") {
    return enrichBooking(booking);
  }

  const listing = await Listing.findById(booking.listingId);
  const isFree = booking.isFree || Number(booking.totalAmount) <= 0;
  booking.status = isFree ? "cancelled" : "withdraw_requested";
  booking.cancelledAt = new Date();
  if (isFree) booking.cancelledBy = "attendee";
  booking.metadata = {
    ...(booking.metadata && typeof booking.metadata === "object"
      ? (booking.metadata as Record<string, unknown>)
      : {}),
    withdrawReason: String(input.reason || "").trim(),
    withdrawRequestedAt: new Date().toISOString(),
  };
  await booking.save();
  await syncEventInventory(booking.listingId);

  const title = listing?.title || booking.eventTitle || "the event";
  const qty = booking.ticketQuantity;
  const image = absolutizeMediaUrl(
    Array.isArray(listing?.images) ? String(listing.images[0] || "") : "",
  );

  if (booking.sellerId.toString() !== booking.userId.toString()) {
    await notify({
      userId: booking.sellerId.toString(),
      type: "listing",
      title: isFree ? "Tickets cancelled" : "Ticket withdrawal request",
      body: isFree
        ? `${booking.attendeeName || "A guest"} cancelled ${ticketLabel(qty)} for "${title}".`
        : `${booking.attendeeName || "A guest"} requested a refund for ${ticketLabel(qty)} for "${title}".`,
      href: `/events/${booking.listingId.toString()}/bookings`,
      image,
    });
  }
  await notify({
    userId: booking.userId.toString(),
    type: "listing",
    title: isFree ? "Tickets cancelled" : "Withdrawal requested",
    body: isFree
      ? `Your tickets for "${title}" were cancelled.`
      : `Your withdrawal request for "${title}" was sent to the organizer.`,
    href: `/event-tickets/${booking._id.toString()}`,
    image,
  });

  return enrichBooking(booking);
}

async function organizerBooking(bookingId: string, userId: string) {
  if (!mongoose.isValidObjectId(bookingId)) {
    throw new AppError(400, "Invalid booking id", "VALIDATION_ERROR");
  }
  const booking = await EventBooking.findById(bookingId);
  if (!booking || booking.sellerId.toString() !== userId) {
    throw new AppError(404, "Booking not found", "NOT_FOUND");
  }
  return booking;
}

/** Refunds the captured payment at the provider, then marks booking + payment refunded. */
async function refundBooking(booking: BookingDoc) {
  const payment = booking.paymentId ? await Payment.findById(booking.paymentId) : null;
  if (!payment || payment.status !== "succeeded") {
    if (payment?.status === "refunded") return;
    throw new AppError(400, "No completed payment found for this booking", "REFUND_UNAVAILABLE");
  }
  await refundProviderPayment({
    provider: payment.provider,
    providerPaymentId: payment.providerPaymentId || "",
    amountMinor: payment.totalMinor,
  });
  payment.status = "refunded";
  payment.refundedAt = new Date();
  await payment.save();
}

async function notifyAttendee(booking: BookingDoc, title: string, body: string) {
  const listing = await Listing.findById(booking.listingId).select("images");
  await notify({
    userId: booking.userId.toString(),
    type: "listing",
    title,
    body,
    href: `/event-tickets/${booking._id.toString()}`,
    image: absolutizeMediaUrl(String(listing?.images?.[0] || "")),
  });
}

function withMetadata(booking: BookingDoc, patch: Record<string, unknown>) {
  booking.metadata = {
    ...(booking.metadata && typeof booking.metadata === "object"
      ? (booking.metadata as Record<string, unknown>)
      : {}),
    ...patch,
  };
}

/** Organizer cancels a confirmed booking. Paid bookings are refunded in full. */
export async function organizerCancelBooking(input: {
  userId: string;
  bookingId: string;
  reason?: string;
}) {
  const booking = await organizerBooking(input.bookingId, input.userId);
  if (!["confirmed", "withdraw_requested"].includes(booking.status)) {
    throw new AppError(400, "Only active bookings can be cancelled", "VALIDATION_ERROR");
  }
  const paid = !booking.isFree && Number(booking.totalAmount) > 0;
  if (paid) await refundBooking(booking);
  booking.status = paid ? "refunded" : "cancelled";
  booking.cancelledBy = "organizer";
  booking.cancelledAt = new Date();
  if (paid) booking.refundedAt = new Date();
  withMetadata(booking, { cancelReason: String(input.reason || "").trim() });
  await booking.save();
  await syncEventInventory(booking.listingId);
  const reason = String(input.reason || "").trim();
  await notifyAttendee(
    booking,
    "Booking cancelled by organizer",
    `Your booking for "${booking.eventTitle}" (${ticketCodeOf(booking)}) was cancelled${
      paid ? " and refunded in full" : ""
    }.${reason ? ` Reason: ${reason}` : ""}`,
  );
  return serializeBooking(booking);
}

export async function organizerResolveWithdrawal(input: {
  userId: string;
  bookingId: string;
  approve: boolean;
  note?: string;
}) {
  const booking = await organizerBooking(input.bookingId, input.userId);
  if (booking.status !== "withdraw_requested") {
    throw new AppError(400, "This booking has no pending withdrawal", "VALIDATION_ERROR");
  }
  const note = String(input.note || "").trim();
  if (input.approve) {
    await refundBooking(booking);
    booking.status = "refunded";
    booking.refundedAt = new Date();
    booking.cancelledBy = "attendee";
    withMetadata(booking, { withdrawResolvedAt: new Date().toISOString(), withdrawNote: note });
    await booking.save();
    await notifyAttendee(
      booking,
      "Refund approved",
      `Your refund for "${booking.eventTitle}" was approved. It may take 5–7 business days to reach you.`,
    );
  } else {
    const listing = await Listing.findById(booking.listingId).select("price extras");
    if (listing) {
      await assertSeatsAvailable(
        listing,
        booking.ticketTierId || null,
        booking.ticketQuantity,
      ).catch(() => {
        throw new AppError(
          409,
          "Those seats were resold. Approve the refund instead.",
          "INSUFFICIENT_TICKETS",
        );
      });
    }
    booking.status = "confirmed";
    booking.cancelledAt = undefined;
    withMetadata(booking, { withdrawResolvedAt: new Date().toISOString(), withdrawNote: note });
    await booking.save();
    await notifyAttendee(
      booking,
      "Withdrawal request declined",
      `The organizer declined your refund request for "${booking.eventTitle}". Your tickets are still valid.${
        note ? ` Note: ${note}` : ""
      }`,
    );
  }
  await syncEventInventory(booking.listingId);
  return serializeBooking(booking);
}

export async function organizerCheckIn(input: {
  userId: string;
  bookingId: string;
  undo?: boolean;
}) {
  const booking = await organizerBooking(input.bookingId, input.userId);
  if (booking.status !== "confirmed") {
    throw new AppError(400, "Only confirmed bookings can be checked in", "VALIDATION_ERROR");
  }
  booking.checkedInAt = input.undo ? undefined : new Date();
  await booking.save();
  return serializeBooking(booking);
}
