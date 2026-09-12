import { env } from "./env.js";

/** True when running in production Node env. */
export function isProd() {
  return env.NODE_ENV === "production";
}

/**
 * Browser / Socket.IO CORS allowlist.
 * Production: CLIENT_URL + optional CORS_ORIGINS only.
 * Development: also localhost:3000 variants.
 */
export function getAllowedOrigins(): string[] {
  const extras = (env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);

  const origins = new Set<string>([
    env.CLIENT_URL.replace(/\/$/, ""),
    ...extras,
  ]);

  if (!isProd()) {
    origins.add("http://localhost:3000");
    origins.add("http://127.0.0.1:3000");
  }

  return Array.from(origins);
}

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // same-origin / curl / native apps
  return getAllowedOrigins().includes(origin.replace(/\/$/, ""));
}
