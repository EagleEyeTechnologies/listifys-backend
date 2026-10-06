import type { Request } from "express";
import mongoose, { Schema } from "mongoose";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

export type LoginMethod =
  "password" | "register" | "password_reset" | "email_otp" | "phone_otp" | "google" | "apple";

const METHOD_LABELS: Record<LoginMethod, string> = {
  password: "Email & password",
  register: "Account created (email)",
  password_reset: "Password reset",
  email_otp: "Email code",
  phone_otp: "Phone OTP",
  google: "Google",
  apple: "Apple",
};

/** Sign-ins older than this are removed automatically. */
const RETENTION_DAYS = 180;

const loginActivitySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    method: { type: String, required: true },
    ip: { type: String, default: "" },
    device: { type: String, default: "" },
    platform: { type: String, enum: ["web", "app", "unknown"], default: "unknown" },
    city: { type: String, default: "" },
    region: { type: String, default: "" },
    country: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

loginActivitySchema.index({ userId: 1, createdAt: -1 });
loginActivitySchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60 });

const LoginActivity = mongoose.model("LoginActivity", loginActivitySchema);

function header(req: Request, name: string) {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v)?.trim() || "";
}

function clientIp(req: Request) {
  return (req.ip || req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

function isPrivateIp(ip: string) {
  return (
    !ip ||
    ip === "::1" ||
    /^(127\.|10\.|192\.168\.|169\.254\.)/.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^f[cd][0-9a-f]{2}:/i.test(ip) ||
    /^fe80:/i.test(ip)
  );
}

function describeDevice(ua: string): { device: string; platform: "web" | "app" | "unknown" } {
  if (!ua) return { device: "Unknown device", platform: "unknown" };
  if (/okhttp/i.test(ua)) return { device: "Listifys app on Android", platform: "app" };
  if (/CFNetwork|Darwin/i.test(ua) && !/Safari/i.test(ua)) {
    return { device: "Listifys app on iOS", platform: "app" };
  }
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /SamsungBrowser/.test(ua)
        ? "Samsung Internet"
        : /Firefox\/|FxiOS/.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS/.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /iPhone|iPad|iPod/.test(ua)
      ? "iOS"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return { device: os ? `${browser} on ${os}` : browser, platform: "web" };
}

type GeoFields = { city: string; region: string; country: string };

/** Location from CDN headers when present (Cloudflare / Vercel / CloudFront). */
function locationFromHeaders(req: Request): GeoFields | null {
  const city =
    header(req, "cf-ipcity") ||
    header(req, "x-vercel-ip-city") ||
    header(req, "cloudfront-viewer-city");
  const region =
    header(req, "cf-region") ||
    header(req, "x-vercel-ip-country-region") ||
    header(req, "cloudfront-viewer-country-region-name");
  const country =
    header(req, "cf-ipcountry") ||
    header(req, "x-vercel-ip-country") ||
    header(req, "cloudfront-viewer-country");
  if (!city && !country) return null;
  return { city: decodeURIComponent(city), region: decodeURIComponent(region), country };
}

async function lookupLocation(ip: string): Promise<GeoFields | null> {
  const template = env.GEOIP_LOOKUP_URL.trim();
  if (!template || template.toLowerCase() === "off" || isPrivateIp(ip)) return null;
  const res = await fetch(template.replace("{ip}", encodeURIComponent(ip)), {
    signal: AbortSignal.timeout(3000),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as Record<string, unknown>;
  if (data.success === false || data.status === "fail" || data.error === true) return null;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const country = text(data.country_name) || text(data.country);
  const geo = {
    city: text(data.city),
    region: text(data.region) || text(data.regionName) || text(data.region_name),
    country,
  };
  return geo.city || geo.country ? geo : null;
}

/** Records a successful sign-in. Never throws; location is filled in after the response. */
export function recordLogin(req: Request, userId: string | undefined, method: LoginMethod) {
  if (!userId || !mongoose.isValidObjectId(userId)) return;
  const ip = clientIp(req);
  const { device, platform } = describeDevice(header(req, "user-agent"));
  const fromHeaders = locationFromHeaders(req);
  void (async () => {
    try {
      const doc = await LoginActivity.create({
        userId,
        method,
        ip,
        device,
        platform,
        ...(fromHeaders || {}),
      });
      if (fromHeaders) return;
      const geo = await lookupLocation(ip).catch(() => null);
      if (geo) await LoginActivity.updateOne({ _id: doc._id }, { $set: geo });
    } catch (err) {
      logger.warn("Could not record login activity", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

function maskIp(ip: string) {
  if (!ip) return "";
  if (ip.includes(".")) {
    const parts = ip.split(".");
    return `${parts[0]}.${parts[1]}.•••.•••`;
  }
  return `${ip.split(":").slice(0, 3).join(":")}:••••`;
}

export async function listLoginActivity(req: Request, userId: string, limit = 20) {
  const rows = await LoginActivity.find({ userId })
    .sort({ createdAt: -1 })
    .limit(Math.min(50, Math.max(1, limit)))
    .lean();
  const ip = clientIp(req);
  const { device } = describeDevice(header(req, "user-agent"));
  let currentMarked = false;
  return rows.map((r) => {
    const isCurrent = !currentMarked && r.ip === ip && r.device === device;
    if (isCurrent) currentMarked = true;
    const method = r.method as LoginMethod;
    return {
      id: String(r._id),
      method,
      methodLabel: METHOD_LABELS[method] || method,
      device: r.device || "Unknown device",
      platform: r.platform || "unknown",
      location: [r.city, r.region, r.country].filter(Boolean).join(", "),
      ip: maskIp(r.ip || ""),
      createdAt: (r as { createdAt?: Date }).createdAt?.toISOString() || null,
      current: isCurrent,
    };
  });
}
