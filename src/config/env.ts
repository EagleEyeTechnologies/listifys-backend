import { config as loadDotenv } from "dotenv";
import { z } from "zod";

/** Prefer `.env.production` when NODE_ENV=production; never override host-injected env. */
const nodeEnv = process.env.NODE_ENV || "development";
if (nodeEnv === "production") {
  loadDotenv({ path: ".env.production" });
} else if (nodeEnv === "test") {
  loadDotenv({ path: ".env.test" });
}
loadDotenv();

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().default(5001),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  REDIS_URL: z.string().optional(),
  /** Upstash REST (preferred for OTP/session when TCP Redis unavailable) */
  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_EXPIRE: z.string().default("1h"),
  JWT_REFRESH_EXPIRE: z.string().default("30d"),
  CLIENT_URL: z.string().default("http://localhost:3000"),
  /** Extra comma-separated browser origins allowed for CORS (production). */
  CORS_ORIGINS: z.string().optional(),
  /**
   * Comma-separated emails allowed to access `/api/admin/*`.
   * Must match marketplace User.email (same login credentials as website).
   */
  ADMIN_EMAILS: z.string().optional(),
  DEFAULT_COUNTRY_CODE: z.enum(["US", "CA", "IN"]).default("IN"),
  ELASTICSEARCH_URL: z.string().optional(),
  ELASTIC_USERNAME: z.string().optional(),
  ELASTIC_PASSWORD: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().default("us-east-1"),
  AWS_S3_BUCKET_NAME: z.string().optional(),
  AWS_S3_BUCKET_URL: z.string().optional(),
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  OTP_TTL_SECONDS: z.coerce.number().default(300),
  /** Server-only Google Places / Geocoding key — never expose to clients */
  GOOGLE_MAPS_SERVER_KEY: z.string().optional(),

  // Social auth (ported from version-1/server) — optional until configured
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().optional(),
  GOOGLE_MOBILE_WEB_CLIENT_ID: z.string().optional(),
  GOOGLE_ANDROID_CLIENT_ID: z.string().optional(),
  GOOGLE_IOS_CLIENT_ID: z.string().optional(),
  /** Extra comma-separated Google OAuth client IDs */
  GOOGLE_CLIENT_IDS: z.string().optional(),
  APPLE_BUNDLE_ID: z.string().optional(),
  APPLE_CLIENT_ID: z.string().optional(),
  /** Extra comma-separated Apple audiences (Services ID / bundle IDs) */
  APPLE_CLIENT_IDS: z.string().optional(),

  /** AES-256-GCM key for legacy chat `enc:` payloads (hex 64 or base64 32-byte) */
  CHAT_ENCRYPTION_KEY: z.string().optional(),

  // Optional — Twilio SMS (Messages API). All three required to send SMS.
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  /** Reserved for Twilio Verify; OTP verify still uses Redis/memory store. */
  TWILIO_VERIFY_SERVICE_SID: z.string().optional(),

  // Optional — email via Resend (preferred) or SMTP (documented; no nodemailer yet)
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === "") return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  // Payments
  RAZORPAY_ENABLED: z
    .string()
    .optional()
    .transform((v) => String(v || "false").toLowerCase() === "true"),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_ENABLED: z
    .string()
    .optional()
    .transform((v) => String(v || "false").toLowerCase() === "true"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${details}`);
  }
  const data = parsed.data;
  if (data.NODE_ENV === "production") {
    const weak =
      /change-me|dev-access|dev-refresh|localhost-secret|password|secret123/i;
    if (weak.test(data.JWT_ACCESS_SECRET) || weak.test(data.JWT_REFRESH_SECRET)) {
      throw new Error(
        "Invalid environment: JWT secrets look like development placeholders — set strong production secrets",
      );
    }
    if (/localhost|127\.0\.0\.1/i.test(data.CLIENT_URL)) {
      throw new Error(
        "Invalid environment: CLIENT_URL must be your public website origin in production",
      );
    }
  }
  return data;
}

export const env = parseEnv();

/** Normalized admin allowlist from ADMIN_EMAILS. */
export function getAdminEmails(): string[] {
  return (env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return getAdminEmails().includes(email.trim().toLowerCase());
}
