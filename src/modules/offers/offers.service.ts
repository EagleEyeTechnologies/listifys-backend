import mongoose from "mongoose";
import { z } from "zod";
import { ListingOffer } from "./listingOffer.model.js";
import { Listing } from "../listings/listing.model.js";
import { User } from "../users/user.model.js";
import { AppError } from "../../utils/AppError.js";
import { listingHrefFromDoc } from "../chat/listingHref.js";
import { startConversation } from "../chat/chat.service.js";
import { createNotification } from "../notifications/notification.service.js";
import { absolutizeMediaUrl } from "../../utils/mediaUrl.js";
import { maxOfferAmount, offerLimitLabel } from "./offerLimits.js";

function assertOfferAmount(amount: number, currency?: string | null) {
  if (!Number.isFinite(amount) || amount <= 0 || amount > maxOfferAmount(currency)) {
    throw new AppError(400, `Offer cannot exceed ${offerLimitLabel(currency)}`, "OFFER_TOO_HIGH");
  }
}

export const createOfferSchema = z.object({
  listingId: z.string().min(1),
  amount: z.number().positive(),
  message: z.string().max(1000).optional(),
});

export const updateOfferSchema = z.object({
  action: z.enum(["accept", "decline", "counter"]),
  counterAmount: z.number().positive().optional(),
  message: z.string().max(1000).optional(),
});

function formatTime(date?: Date | null) {
  if (!date) return "";
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

async function serialize(doc: InstanceType<typeof ListingOffer>, viewerId: string) {
  const [buyer, seller] = await Promise.all([User.findById(doc.buyer), User.findById(doc.seller)]);
  const createdAt =
    (doc as InstanceType<typeof ListingOffer> & { createdAt?: Date }).createdAt || new Date();
  const viewerIsSeller = doc.seller.toString() === viewerId;
  return {
    id: doc._id.toString(),
    listingId: doc.listing.toString(),
    listingTitle: doc.listingTitle,
    listingImage: absolutizeMediaUrl(doc.listingImage),
    listingHref: doc.listingHref,
    buyerId: doc.buyer.toString(),
    sellerId: doc.seller.toString(),
    buyerName: buyer?.name || "Buyer",
    buyerAvatar: absolutizeMediaUrl(buyer?.avatar),
    sellerName: seller?.name || "Seller",
    sellerAvatar: absolutizeMediaUrl(seller?.avatar),
    offerPrice: doc.counterAmount || doc.amount,
    listPrice: doc.listPrice,
    currency: doc.currency,
    message: doc.message || "",
    time: formatTime(createdAt),
    status: doc.status,
    role: viewerIsSeller ? "received" : "sent",
    createdAt: createdAt.toISOString(),
  };
}

export async function listOffers(userId: string) {
  const rows = await ListingOffer.find({
    $or: [{ seller: userId }, { buyer: userId }],
  })
    .sort({ createdAt: -1 })
    .limit(100);
  return Promise.all(rows.map((row) => serialize(row, userId)));
}

export async function createOffer(buyerId: string, input: z.infer<typeof createOfferSchema>) {
  if (!mongoose.isValidObjectId(input.listingId)) {
    throw new AppError(400, "Invalid listing", "VALIDATION_ERROR");
  }
  const listing = await Listing.findById(input.listingId);
  if (!listing || listing.status === "removed") {
    throw new AppError(404, "Listing not found", "NOT_FOUND");
  }
  const sellerId = listing.seller.toString();
  if (sellerId === buyerId) {
    throw new AppError(400, "Cannot offer on your own listing", "VALIDATION_ERROR");
  }
  assertOfferAmount(input.amount, listing.currency);

  const offer = await ListingOffer.create({
    listing: listing._id,
    listingTitle: listing.title,
    listingImage: listing.images?.[0] || "",
    listingHref: listingHrefFromDoc(listing),
    buyer: buyerId,
    seller: listing.seller,
    amount: input.amount,
    listPrice: listing.price,
    currency: listing.currency,
    message: input.message || "",
    status: "pending",
  });

  const buyer = await User.findById(buyerId);
  await createNotification({
    userId: sellerId,
    type: "offer",
    title: `New offer on ${listing.title}`,
    body: `${buyer?.name || "Someone"} offered ${listing.currency} ${input.amount}`,
    href: "/profile?tab=offers",
    image: absolutizeMediaUrl(listing.images?.[0] || buyer?.avatar || ""),
  });

  // Reuse the same 1:1 user conversation (listing is context only).
  try {
    await startConversation(buyerId, {
      recipientId: sellerId,
      listingId: listing._id.toString(),
      text: `Offer on "${listing.title}": ${listing.currency} ${input.amount}${
        input.message?.trim() ? `\n\n${input.message.trim()}` : ""
      }`,
    });
  } catch {
    /* offer already saved; chat notify is best-effort */
  }

  return serialize(offer, buyerId);
}

export async function updateOffer(
  userId: string,
  offerId: string,
  input: z.infer<typeof updateOfferSchema>,
) {
  if (!mongoose.isValidObjectId(offerId)) {
    throw new AppError(404, "Offer not found", "NOT_FOUND");
  }
  const offer = await ListingOffer.findById(offerId);
  if (!offer) throw new AppError(404, "Offer not found", "NOT_FOUND");
  const sellerId = offer.seller.toString();
  const buyerId = offer.buyer.toString();
  const isSeller = sellerId === userId;
  const isBuyer = buyerId === userId;
  if (!isSeller && !isBuyer) {
    throw new AppError(403, "You cannot respond to this offer", "FORBIDDEN");
  }
  if (offer.status === "accepted" || offer.status === "declined") {
    throw new AppError(400, "Offer already closed", "VALIDATION_ERROR");
  }
  if (isSeller && offer.status !== "pending") {
    throw new AppError(400, "Waiting for the buyer to respond to your counter", "VALIDATION_ERROR");
  }
  if (isBuyer && offer.status !== "countered") {
    throw new AppError(400, "Waiting for the seller to respond", "VALIDATION_ERROR");
  }

  if (input.action === "accept") offer.status = "accepted";
  if (input.action === "decline") offer.status = "declined";
  if (input.action === "counter") {
    if (!input.counterAmount) {
      throw new AppError(400, "Counter amount required", "VALIDATION_ERROR");
    }
    assertOfferAmount(input.counterAmount, offer.currency);
    if (isSeller) {
      offer.status = "countered";
      offer.counterAmount = input.counterAmount;
    } else {
      offer.status = "pending";
      offer.amount = input.counterAmount;
      offer.counterAmount = undefined;
    }
    if (input.message) offer.message = input.message;
  }
  const buyerCountered = isBuyer && input.action === "counter";
  await offer.save();
  if (buyerCountered) {
    await ListingOffer.updateOne({ _id: offer._id }, { $unset: { counterAmount: 1 } });
  }

  const agreed = offer.counterAmount || offer.amount;
  const otherId = isSeller ? buyerId : sellerId;
  const title = `Offer ${offer.status} — ${offer.listingTitle}`;
  const body = isSeller
    ? offer.status === "countered"
      ? `The seller countered at ${offer.currency} ${offer.counterAmount}. You can accept, decline, or counter again.`
      : offer.status === "accepted"
        ? `The seller accepted your offer of ${offer.currency} ${agreed}.`
        : "The seller declined your offer."
    : offer.status === "pending"
      ? `The buyer countered at ${offer.currency} ${offer.amount}. You can accept, decline, or counter again.`
      : offer.status === "accepted"
        ? `The buyer accepted your counter of ${offer.currency} ${agreed}.`
        : "The buyer declined your counter.";

  await createNotification({
    userId: otherId,
    type: "offer",
    title,
    body,
    href: "/profile?tab=offers",
    image: offer.listingImage,
  });

  return serialize(offer, userId);
}
