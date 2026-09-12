import type { ListingDocument } from "../listings/listing.model.js";

/** Mirror of next-website listingHref for API-created chats. */
export function listingHrefFromDoc(listing: {
  _id: { toString(): string };
  category: string;
  subcategory?: string | null;
}) {
  const id = listing._id.toString();
  if (listing.category === "services") {
    const slug =
      (listing.subcategory || "cleaning")
        .toLowerCase()
        .replace(/&/g, " ")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "cleaning";
    return `/services/${slug}/${id}`;
  }
  if (listing.category === "jobs") return `/jobs/${id}`;
  return `/${listing.category}/${id}`;
}

// re-export for callers that need the type
export type { ListingDocument };
