/** Shared slug helpers for listing / seller SEO URLs. */

export function slugify(input: string, fallback = "item"): string {
  const base = String(input || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || fallback;
}

/** Title slug + short unique suffix from Mongo id (stable, collision-resistant). */
export function listingSlugFrom(title: string, id: string): string {
  const short = String(id).replace(/[^a-f0-9]/gi, "").slice(-6).toLowerCase() || "item";
  return `${slugify(title, "listing")}-${short}`;
}

export function sellerSlugFrom(name: string, id: string): string {
  const short = String(id).replace(/[^a-f0-9]/gi, "").slice(-6).toLowerCase() || "user";
  return `${slugify(name, "seller")}-${short}`;
}

export function isMongoObjectId(value: string): boolean {
  return /^[a-f\d]{24}$/i.test(value);
}
