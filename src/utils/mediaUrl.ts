import { env } from "../config/env.js";

const LOCAL_ASSET_PREFIXES = [
  "/images/",
  "/icons/",
  "/categories/",
  "/collections/",
  "/static-",
];

const S3_KEY_PREFIXES = [
  "profiles/",
  "profile-images/",
  "electronics/",
  "vehicles/",
  "vehicals/",
  "mobiles/",
  "furniture/",
  "fashion/",
  "sports/",
  "collectibles/",
  "pets/",
  "toys/",
  "books/",
  "beauty/",
  "others/",
  "takecare/",
  "events/",
  "forsale/",
  "listings/",
  "services/",
  "properties/",
  "jobs/",
  "chats/",
  "users/",
  "avatars/",
  "banners/",
  "uploads/",
  "media/",
  "storage/",
];

function s3Base() {
  return (env.AWS_S3_BUCKET_URL || "").replace(/\/$/, "");
}

function isLocalPublicAsset(path: string) {
  if (LOCAL_ASSET_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return true;
  }
  return /^\/[A-Za-z0-9._-]+\.(png|jpe?g|webp|svg|avif|gif)$/i.test(path);
}

function extractLegacyImageKey(url: string): string | null {
  const idx = url.toLowerCase().indexOf("/api/images/");
  if (idx === -1) return null;
  let key = url.slice(idx + "/api/images/".length).split(/[?#]/)[0];
  try {
    key = decodeURIComponent(key);
  } catch {
    // keep raw key
  }
  if (/^https?:\/\//i.test(key)) {
    try {
      const nested = new URL(key);
      if (nested.pathname.toLowerCase().startsWith("/api/images/")) {
        return nested.pathname.slice("/api/images/".length).replace(/^\/+/, "");
      }
      return nested.pathname.replace(/^\/+/, "") || null;
    } catch {
      return key.replace(/^\/+/, "") || null;
    }
  }
  return key.replace(/^\/+/, "") || null;
}

function toS3Url(key: string) {
  const base = s3Base();
  const clean = key.replace(/^\/+/, "");
  return base ? `${base}/${clean}` : `/${clean}`;
}

/** Absolute public URL for listing / avatar / banner values stored as keys or proxies. */
export function absolutizeMediaUrl(url?: string | null): string {
  const v = (url || "").trim();
  if (!v) return "";
  if (v.startsWith("data:") || v.startsWith("blob:")) return v;

  const proxyKey = extractLegacyImageKey(v);
  if (proxyKey) return toS3Url(proxyKey);

  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("//")) return `https:${v}`;

  if (isLocalPublicAsset(v)) return v;

  const base = s3Base();
  if (v.startsWith("/")) {
    if (base && (v.startsWith("/uploads") || v.startsWith("/media") || v.startsWith("/storage"))) {
      return `${base}${v}`;
    }
    const key = v.replace(/^\/+/, "");
    if (
      base &&
      (S3_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
        /\.(?:jpe?g|png|webp|gif|avif|heic|heif|bmp)$/i.test(key))
    ) {
      return toS3Url(key);
    }
    return v;
  }

  if (base) return toS3Url(v);
  return v;
}
