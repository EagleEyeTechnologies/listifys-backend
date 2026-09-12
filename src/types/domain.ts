export const CATEGORY_SLUGS = [
  "electronics",
  "vehicles",
  "mobiles",
  "furniture",
  "fashion",
  "toys",
  "sports",
  "collectibles",
  "pets",
  "books",
  "beauty",
  "others",
  "properties",
  "jobs",
  "events",
  "services",
  "takecare",
] as const;

export type CategorySlug = (typeof CATEGORY_SLUGS)[number];
export type ListingIntent = "sale" | "wanted" | "free";
export type CountryCode = "US" | "CA" | "IN";
export type ListingStatus =
  | "active"
  | "sold"
  | "paused"
  | "expired"
  | "removed";
