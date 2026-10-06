import type mongoose from "mongoose";
import { EventBooking } from "./eventBooking.model.js";
import { Listing } from "../listings/listing.model.js";
import { AppError } from "../../utils/AppError.js";

type ListingLike = {
  _id: mongoose.Types.ObjectId;
  price?: number | null;
  extras?: unknown;
};

export type TicketTier = {
  id: string;
  name: string;
  price: number;
  desc: string;
  /** Seats for this tier. Null means only the event total limits it. */
  quantity: number | null;
};

export type TierInventory = TicketTier & { sold: number; left: number | null };

export type EventInventory = {
  /** Null means the organizer did not cap tickets. */
  total: number | null;
  sold: number;
  left: number | null;
  soldOut: boolean;
  tiers: TierInventory[];
};

/** Bookings that currently hold seats. Withdrawal requests have already released theirs. */
export const SEAT_HOLDING_STATUSES = ["confirmed"] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function eventExtrasOf(listing: ListingLike): Record<string, unknown> {
  const extras = record(listing.extras);
  return record(extras.event) || {};
}

export function eventTiers(listing: ListingLike): TicketTier[] {
  const event = eventExtrasOf(listing);
  const raw = Array.isArray(event.tickets)
    ? event.tickets
    : Array.isArray(event.ticketTiers)
      ? event.ticketTiers
      : [];
  const base = Number(listing.price || 0);
  return raw
    .map((row, i) => {
      const t = record(row);
      const price = t.price == null || t.price === "" ? base : Number(t.price);
      return {
        id: String(t.id || `tier-${i}`),
        name: String(t.name || t.title || "General Pass").trim() || "General Pass",
        price: Number.isFinite(price) && price > 0 ? price : 0,
        desc: String(t.desc || t.description || ""),
        quantity: positiveInt(t.quantity ?? t.total),
      };
    })
    .filter((t) => t.name);
}

/** Price + tier for a checkout. Falls back to the listing price when no tiers are configured. */
export function resolveTicketPricing(listing: ListingLike, tierId?: string) {
  const tiers = eventTiers(listing);
  if (!tiers.length) {
    return { tier: null as TicketTier | null, unitPrice: Math.max(0, Number(listing.price || 0)) };
  }
  const tier = tierId ? tiers.find((t) => t.id === tierId) : tiers.length === 1 ? tiers[0] : null;
  if (!tier) {
    throw new AppError(400, "Choose a ticket type", "TICKET_TIER_REQUIRED");
  }
  return { tier, unitPrice: tier.price };
}

async function soldByTier(listingId: mongoose.Types.ObjectId) {
  const rows = await EventBooking.aggregate<{ _id: string; qty: number }>([
    { $match: { listingId, status: { $in: [...SEAT_HOLDING_STATUSES] } } },
    { $group: { _id: { $ifNull: ["$ticketTierId", ""] }, qty: { $sum: "$ticketQuantity" } } },
  ]);
  const map = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    map.set(String(row._id || ""), row.qty);
    total += row.qty;
  }
  return { map, total };
}

/** Event cap. Older listings stored only a remaining count, so rebuild the original cap from it. */
function totalCap(event: Record<string, unknown>, sold: number): number | null {
  const explicit = positiveInt(event.ticketsTotal);
  if (explicit) return explicit;
  if (event.ticketsTotal === undefined) {
    const legacyLeft = positiveInt(event.ticketsAvailable);
    if (legacyLeft) return legacyLeft + sold;
  }
  return null;
}

export async function computeInventory(listing: ListingLike): Promise<EventInventory> {
  const event = eventExtrasOf(listing);
  const { map, total: sold } = await soldByTier(listing._id);
  const total = totalCap(event, sold);
  const left = total == null ? null : Math.max(0, total - sold);
  const tiers = eventTiers(listing).map((tier) => {
    const tierSold = map.get(tier.id) || 0;
    const own = tier.quantity == null ? null : Math.max(0, tier.quantity - tierSold);
    const tierLeft = own == null ? left : left == null ? own : Math.min(own, left);
    return { ...tier, sold: tierSold, left: tierLeft };
  });
  const tiersSoldOut = tiers.length > 0 && tiers.every((t) => t.left === 0);
  return { total, sold, left, soldOut: left === 0 || tiersSoldOut, tiers };
}

/** Writes sold / remaining counts back onto the listing so browse cards and detail pages stay accurate. */
export async function syncEventInventory(listingId: mongoose.Types.ObjectId | string) {
  const listing = await Listing.findById(listingId).select("price extras category");
  if (!listing || listing.category !== "events") return null;
  const inventory = await computeInventory(listing);
  const event = eventExtrasOf(listing);
  const rawTickets = Array.isArray(event.tickets) ? event.tickets : null;
  const $set: Record<string, unknown> = {
    "extras.event.ticketsSold": inventory.sold,
    "extras.event.ticketsAvailable": inventory.left ?? 0,
    "extras.event.soldOut": inventory.soldOut,
  };
  if (inventory.total != null) $set["extras.event.ticketsTotal"] = inventory.total;
  if (inventory.tiers.length) $set.price = Math.min(...inventory.tiers.map((t) => t.price));
  if (rawTickets) {
    $set["extras.event.tickets"] = rawTickets.map((row, i) => {
      const t = record(row);
      const inv = inventory.tiers[i];
      return inv ? { ...t, id: inv.id, sold: inv.sold, left: inv.left } : t;
    });
  }
  await Listing.updateOne({ _id: listing._id }, { $set });
  return inventory;
}

export async function assertSeatsAvailable(
  listing: ListingLike,
  tierId: string | null,
  qty: number,
) {
  const inventory = await computeInventory(listing);
  if (inventory.left != null && qty > inventory.left) {
    throw new AppError(
      400,
      inventory.left === 0 ? "This event is sold out" : `Only ${inventory.left} ticket(s) left`,
      "INSUFFICIENT_TICKETS",
    );
  }
  if (tierId) {
    const tier = inventory.tiers.find((t) => t.id === tierId);
    if (tier && tier.left != null && qty > tier.left) {
      throw new AppError(
        400,
        tier.left === 0
          ? `${tier.name} is sold out`
          : `Only ${tier.left} ${tier.name} ticket(s) left`,
        "INSUFFICIENT_TICKETS",
      );
    }
  }
  return inventory;
}
