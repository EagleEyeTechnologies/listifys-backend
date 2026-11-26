import mongoose from "mongoose";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import { Listing } from "../listings/listing.model.js";
import { User } from "../users/user.model.js";
import { EventBooking } from "./eventBooking.model.js";
import { EventOrganizerPayout } from "./eventPayout.model.js";
import { eventEndFromExtras, isEventPastFromExtras } from "./eventDate.js";

export function platformFeePercent() {
  const n = Number(env.EVENT_TICKET_PLATFORM_FEE_PERCENT);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 10;
}

export function toMinorUnits(major: number) {
  return Math.round(Number(major || 0) * 100);
}

export function fromMinorUnits(minor: number) {
  return Math.round(Number(minor || 0)) / 100;
}

export function splitTicketAmount(grossMinor: number, feePercent = platformFeePercent()) {
  const gross = Math.max(0, Math.round(grossMinor));
  const feeMinor = Math.min(gross, Math.round((gross * feePercent) / 100));
  return { grossMinor: gross, feeMinor, organizerMinor: gross - feeMinor, feePercent };
}

function moneyLabel(currency: string, major: number) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "INR",
      maximumFractionDigits: 2,
    }).format(major);
  } catch {
    return `${currency || ""} ${major.toFixed(2)}`.trim();
  }
}

function serializePayout(doc: InstanceType<typeof EventOrganizerPayout>) {
  const currency = doc.currency || "INR";
  return {
    id: doc._id.toString(),
    organizerId: doc.organizerId.toString(),
    listingId: doc.listingId.toString(),
    eventTitle: doc.eventTitle || "",
    currency,
    countryCode: doc.countryCode,
    grossMinor: doc.grossMinor,
    refundedMinor: doc.refundedMinor,
    feeMinor: doc.feeMinor,
    netMinor: doc.netMinor,
    feePercent: doc.feePercent,
    gross: fromMinorUnits(doc.grossMinor),
    refunded: fromMinorUnits(doc.refundedMinor),
    fee: fromMinorUnits(doc.feeMinor),
    net: fromMinorUnits(doc.netMinor),
    grossDisplay: moneyLabel(currency, fromMinorUnits(doc.grossMinor)),
    refundedDisplay: moneyLabel(currency, fromMinorUnits(doc.refundedMinor)),
    feeDisplay: moneyLabel(currency, fromMinorUnits(doc.feeMinor)),
    netDisplay: moneyLabel(currency, fromMinorUnits(doc.netMinor)),
    status: doc.status,
    eventEndsAt: doc.eventEndsAt?.toISOString?.() || null,
    paidAt: doc.paidAt?.toISOString?.() || null,
    reference: doc.reference || "",
    notes: doc.notes || "",
    updatedAt: (doc as { updatedAt?: Date }).updatedAt?.toISOString?.() || null,
  };
}

export type PayoutProfile = {
  method: "bank" | "upi" | "";
  accountHolderName: string;
  accountNumber: string;
  ifsc: string;
  upiId: string;
  updatedAt: string | null;
};

export function serializePayoutProfile(user: InstanceType<typeof User> | null): PayoutProfile {
  const raw = (user as { payoutProfile?: Record<string, unknown> } | null)?.payoutProfile || {};
  const method = raw.method === "bank" || raw.method === "upi" ? raw.method : "";
  return {
    method,
    accountHolderName: String(raw.accountHolderName || ""),
    accountNumber: String(raw.accountNumber || ""),
    ifsc: String(raw.ifsc || ""),
    upiId: String(raw.upiId || ""),
    updatedAt:
      raw.updatedAt instanceof Date
        ? raw.updatedAt.toISOString()
        : typeof raw.updatedAt === "string"
          ? raw.updatedAt
          : null,
  };
}

export function payoutProfileComplete(profile: PayoutProfile) {
  if (profile.method === "upi") {
    return Boolean(profile.accountHolderName.trim() && profile.upiId.trim());
  }
  if (profile.method === "bank") {
    return Boolean(
      profile.accountHolderName.trim() &&
      profile.accountNumber.trim() &&
      profile.ifsc.trim().length >= 4,
    );
  }
  return false;
}

/** Recompute ledger row for one event listing from bookings. */
export async function syncOrganizerPayoutForListing(listingId: string) {
  if (!mongoose.isValidObjectId(listingId)) return null;
  const listing = await Listing.findById(listingId);
  if (!listing || listing.category !== "events") return null;

  const organizerId = listing.seller;
  const rows = await EventBooking.find({
    listingId: listing._id,
    isFree: false,
    $or: [
      { status: { $in: ["confirmed", "refunded", "withdraw_requested"] } },
      { status: "cancelled", confirmedAt: { $ne: null } },
    ],
  }).select("status totalAmount metadata refundedAt confirmedAt");

  let grossMinor = 0;
  let refundedMinor = 0;
  for (const row of rows) {
    if (!row.confirmedAt && row.status !== "confirmed" && row.status !== "refunded") continue;
    const bookingGross = toMinorUnits(Number(row.totalAmount || 0));
    grossMinor += bookingGross;
    if (row.status === "refunded") {
      const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
      const refundAmount =
        typeof (meta as { refundAmount?: unknown }).refundAmount === "number"
          ? Number((meta as { refundAmount: number }).refundAmount)
          : Number(row.totalAmount || 0);
      refundedMinor += toMinorUnits(
        Math.min(Number(row.totalAmount || 0), Math.max(0, refundAmount)),
      );
    }
  }

  const netSales = Math.max(0, grossMinor - refundedMinor);
  const feePercent = platformFeePercent();
  const feeMinor = Math.min(netSales, Math.round((netSales * feePercent) / 100));
  const netMinor = Math.max(0, netSales - feeMinor);
  const eventEndsAt = eventEndFromExtras(listing.extras, listing.countryCode);
  const eventPast = isEventPastFromExtras(listing.extras, listing.countryCode);
  const currency = (listing.currency || "INR").toUpperCase();

  let doc = await EventOrganizerPayout.findOne({ listingId: listing._id });
  if (!doc) {
    doc = new EventOrganizerPayout({
      organizerId,
      listingId: listing._id,
      currency,
      countryCode: listing.countryCode || "IN",
    });
  }

  const wasPaid = doc.status === "paid";
  doc.organizerId = organizerId as mongoose.Types.ObjectId;
  doc.eventTitle = listing.title || "";
  doc.currency = currency;
  doc.countryCode = listing.countryCode || "IN";
  doc.grossMinor = grossMinor;
  doc.refundedMinor = refundedMinor;
  doc.feeMinor = feeMinor;
  doc.netMinor = netMinor;
  doc.feePercent = feePercent;
  doc.eventEndsAt = eventEndsAt;

  if (wasPaid) {
    doc.status = "paid";
  } else if (netMinor <= 0) {
    doc.status = eventPast ? "payable" : "pending";
    if (netMinor <= 0 && eventPast) doc.status = "pending";
  } else if (eventPast) {
    doc.status = "payable";
  } else {
    doc.status = "pending";
  }

  await doc.save();
  return doc;
}

/** Promote ended events to payable without re-aggregating bookings. */
export async function promotePayablePayouts(filter?: { organizerId?: string }) {
  const match: Record<string, unknown> = {
    status: "pending",
    netMinor: { $gt: 0 },
    eventEndsAt: { $ne: null, $lte: new Date() },
  };
  if (filter?.organizerId && mongoose.isValidObjectId(filter.organizerId)) {
    match.organizerId = new mongoose.Types.ObjectId(filter.organizerId);
  }
  await EventOrganizerPayout.updateMany(match, { $set: { status: "payable" } });
}

async function ensureMissingPayoutLedgers(organizerId: string) {
  const [listings, existing] = await Promise.all([
    Listing.find({
      seller: organizerId,
      category: "events",
      status: { $ne: "removed" },
    })
      .select("_id")
      .lean(),
    EventOrganizerPayout.find({ organizerId }).select("listingId").lean(),
  ]);
  const have = new Set(existing.map((e) => String(e.listingId)));
  const missing = listings.filter((l) => !have.has(String(l._id)));
  if (!missing.length) return;

  // Sync only missing rows, in small parallel batches (ledger is updated on each payment/refund).
  const batchSize = 5;
  for (let i = 0; i < missing.length; i += batchSize) {
    const chunk = missing.slice(i, i + batchSize);
    await Promise.all(chunk.map((l) => syncOrganizerPayoutForListing(String(l._id))));
  }
}

export async function getOrganizerEarnings(organizerId: string) {
  await ensureMissingPayoutLedgers(organizerId);
  await promotePayablePayouts({ organizerId });

  const items = await EventOrganizerPayout.find({ organizerId }).sort({ updatedAt: -1 }).limit(200);

  const serialized = items.map(serializePayout);
  const payable = serialized.filter((i) => i.status === "payable");
  const pending = serialized.filter((i) => i.status === "pending");
  const paid = serialized.filter((i) => i.status === "paid");

  const sumNet = (rows: typeof serialized) => rows.reduce((s, r) => s + r.netMinor, 0);
  const currency = serialized[0]?.currency || "INR";

  const user = await User.findById(organizerId).select("payoutProfile name email phone");
  const payoutProfile = serializePayoutProfile(user);

  return {
    feePercent: platformFeePercent(),
    payoutProfile,
    payoutProfileComplete: payoutProfileComplete(payoutProfile),
    summary: {
      currency,
      payableMinor: sumNet(payable),
      pendingMinor: sumNet(pending),
      paidMinor: sumNet(paid),
      payableDisplay: moneyLabel(currency, fromMinorUnits(sumNet(payable))),
      pendingDisplay: moneyLabel(currency, fromMinorUnits(sumNet(pending))),
      paidDisplay: moneyLabel(currency, fromMinorUnits(sumNet(paid))),
      eventsPayable: payable.length,
      eventsPending: pending.length,
      eventsPaid: paid.length,
    },
    items: serialized,
  };
}

export async function getOrganizerPayoutForListing(listingId: string, organizerId: string) {
  const listing = await Listing.findById(listingId);
  if (!listing || listing.category !== "events") {
    throw new AppError(404, "Event listing not found", "NOT_FOUND");
  }
  if (listing.seller.toString() !== organizerId) {
    throw new AppError(403, "Only the organizer can view earnings", "FORBIDDEN");
  }
  const doc = await syncOrganizerPayoutForListing(listingId);
  if (!doc) throw new AppError(404, "Payout not found", "NOT_FOUND");
  return serializePayout(doc);
}

export async function updateOrganizerPayoutProfile(
  userId: string,
  input: {
    method: "bank" | "upi";
    accountHolderName: string;
    accountNumber?: string;
    ifsc?: string;
    upiId?: string;
  },
) {
  const user = await User.findById(userId);
  if (!user || !user.isActive) throw new AppError(401, "User not found", "UNAUTHORIZED");

  const accountHolderName = String(input.accountHolderName || "").trim();
  if (accountHolderName.length < 2) {
    throw new AppError(400, "Enter the account holder name", "VALIDATION_ERROR");
  }

  if (input.method === "upi") {
    const upiId = String(input.upiId || "")
      .trim()
      .toLowerCase();
    if (!/^[\w.-]{2,}@[\w.-]{2,}$/.test(upiId)) {
      throw new AppError(400, "Enter a valid UPI ID", "VALIDATION_ERROR");
    }
    (user as unknown as { payoutProfile: Record<string, unknown> }).payoutProfile = {
      method: "upi",
      accountHolderName,
      accountNumber: "",
      ifsc: "",
      upiId,
      updatedAt: new Date(),
    };
  } else {
    const accountNumber = String(input.accountNumber || "").replace(/\s+/g, "");
    const ifsc = String(input.ifsc || "")
      .trim()
      .toUpperCase();
    if (accountNumber.length < 6 || accountNumber.length > 20) {
      throw new AppError(400, "Enter a valid bank account number", "VALIDATION_ERROR");
    }
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
      throw new AppError(400, "Enter a valid IFSC code", "VALIDATION_ERROR");
    }
    (user as unknown as { payoutProfile: Record<string, unknown> }).payoutProfile = {
      method: "bank",
      accountHolderName,
      accountNumber,
      ifsc,
      upiId: "",
      updatedAt: new Date(),
    };
  }

  await user.save();
  return serializePayoutProfile(user);
}

export async function listAdminEventPayouts(input: {
  page: number;
  limit: number;
  status?: string;
  q?: string;
}) {
  const page = Math.max(1, input.page || 1);
  const limit = Math.min(100, Math.max(1, input.limit || 20));
  const filter: Record<string, unknown> = {};
  if (input.status && input.status !== "all") filter.status = input.status;

  // Cheap status flip only — full booking re-agg happens on payment/refund/organizer view.
  await promotePayablePayouts();

  let qFilter = filter;
  if (input.q?.trim()) {
    const q = input.q.trim();
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const users = await User.find({
      $or: [{ name: new RegExp(escaped, "i") }, { email: new RegExp(escaped, "i") }],
    })
      .select("_id")
      .limit(50)
      .lean();
    qFilter = {
      ...filter,
      $or: [
        { eventTitle: new RegExp(escaped, "i") },
        { reference: new RegExp(escaped, "i") },
        { organizerId: { $in: users.map((u) => u._id) } },
      ],
    };
  }

  const [total, rows, payableAgg] = await Promise.all([
    EventOrganizerPayout.countDocuments(qFilter),
    EventOrganizerPayout.find(qFilter)
      .sort({ status: 1, updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    EventOrganizerPayout.aggregate([
      { $match: { status: "payable" } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          netMinor: { $sum: "$netMinor" },
        },
      },
    ]),
  ]);

  const organizerIds = [...new Set(rows.map((r) => r.organizerId.toString()))];
  const organizers = await User.find({ _id: { $in: organizerIds } })
    .select("name email phone payoutProfile")
    .lean();
  const byId = new Map(organizers.map((u) => [String(u._id), u]));

  const items = rows.map((row) => {
    const org = byId.get(row.organizerId.toString());
    const profile = serializePayoutProfile(org as InstanceType<typeof User> | null);
    return {
      ...serializePayout(row),
      organizerName: org?.name || "",
      organizerEmail: org?.email || "",
      organizerPhone: org?.phone || "",
      payoutProfile: profile,
      payoutProfileComplete: payoutProfileComplete(profile),
    };
  });

  return {
    items,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    stats: {
      payableCount: payableAgg[0]?.count || 0,
      payableNetMinor: payableAgg[0]?.netMinor || 0,
      payableNetDisplay: moneyLabel("INR", fromMinorUnits(payableAgg[0]?.netMinor || 0)),
      feePercent: platformFeePercent(),
    },
  };
}

export async function markOrganizerPayoutPaid(input: {
  payoutId: string;
  adminUserId?: string;
  reference?: string;
  notes?: string;
}) {
  if (!mongoose.isValidObjectId(input.payoutId)) {
    throw new AppError(400, "Invalid payout id", "VALIDATION_ERROR");
  }
  const doc = await EventOrganizerPayout.findById(input.payoutId);
  if (!doc) throw new AppError(404, "Payout not found", "NOT_FOUND");

  await syncOrganizerPayoutForListing(doc.listingId.toString());
  const fresh = await EventOrganizerPayout.findById(input.payoutId);
  if (!fresh) throw new AppError(404, "Payout not found", "NOT_FOUND");

  if (fresh.status === "paid") {
    return serializePayout(fresh);
  }
  if (fresh.netMinor <= 0) {
    throw new AppError(400, "Nothing to pay for this event", "VALIDATION_ERROR");
  }
  if (fresh.status !== "payable" && fresh.status !== "processing" && fresh.status !== "failed") {
    throw new AppError(
      400,
      "This payout is not payable yet — wait until the event has ended",
      "VALIDATION_ERROR",
    );
  }

  fresh.status = "paid";
  fresh.paidAt = new Date();
  fresh.reference = String(input.reference || "").trim();
  fresh.notes = String(input.notes || "").trim();
  if (input.adminUserId && mongoose.isValidObjectId(input.adminUserId)) {
    fresh.paidByAdminId = new mongoose.Types.ObjectId(input.adminUserId);
  }
  await fresh.save();
  return serializePayout(fresh);
}
