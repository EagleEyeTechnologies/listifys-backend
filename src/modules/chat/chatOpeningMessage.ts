/**
 * Opening chat line when a buyer messages a seller about a listing.
 */
export function chatOpeningMessage(listing: {
  title?: string | null;
  category?: string | null;
  subcategory?: string | null;
  intent?: string | null;
}): string {
  const title = (listing.title || "this listing").trim() || "this listing";
  const cat = String(listing.category || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  const sub = String(listing.subcategory || "").toLowerCase();

  if (cat === "jobs") {
    return `Hi, I'm interested in the "${title}" role. Is this position still open?`;
  }
  if (cat === "events") {
    return `Hi, I'd like to know more about "${title}". Are tickets / spots still available?`;
  }
  if (cat === "properties") {
    if (/rent|pg|hostel|roommate/.test(sub)) {
      return `Hi, I'm interested in "${title}". Is this still available to rent / view?`;
    }
    return `Hi, I'm interested in "${title}". Is this still available? I'd like to know more.`;
  }
  if (cat === "services" || cat === "takecare") {
    return `Hi, I'm interested in your "${title}" service. Is this still available?`;
  }
  if (listing.intent === "wanted") {
    return `Hi, I saw your wanted ad for "${title}". I may be able to help — is this still needed?`;
  }
  if (listing.intent === "free") {
    return `Hi, is "${title}" still available to pick up?`;
  }
  return `Hi, is "${title}" still available?`;
}

export function chatListingSwitchMessage(listingTitle: string): string {
  const title = (listingTitle || "a listing").trim() || "a listing";
  return `Regarding: ${title}`;
}
