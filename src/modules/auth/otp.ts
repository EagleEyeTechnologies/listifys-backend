import { randomInt } from "crypto";
import { env } from "../../config/env.js";
import { kv } from "../../redis/client.js";
import { logger } from "../../utils/logger.js";
import { AppError } from "../../utils/AppError.js";
import { renderOtpEmail, type OtpEmailPurpose } from "../mail/brandedEmail.js";

export type OtpDelivery = "logged" | "sms" | "email" | "unavailable";

const TWILIO_VERIFY_MARKER = "twilio-verify";
/** Wrong guesses allowed while the code is still inside its expiry window. */
const OTP_MAX_ATTEMPTS = 5;
const OTP_ATTEMPTS_MESSAGE = "Too many incorrect attempts. Request a new OTP.";

function otpKey(channel: "email" | "phone", target: string) {
  return `otp:${channel}:${target}`;
}

function attemptsKey(channel: "email" | "phone", target: string) {
  return `otp-attempts:${channel}:${target}`;
}

function lockKey(channel: "email" | "phone", target: string) {
  return `otp-lock:${channel}:${target}`;
}

function attemptsExceeded(): never {
  throw new AppError(400, OTP_ATTEMPTS_MESSAGE, "OTP_ATTEMPTS_EXCEEDED");
}

async function clearOtpState(channel: "email" | "phone", target: string) {
  await kv.del(attemptsKey(channel, target));
  await kv.del(lockKey(channel, target));
}

function twilioAuthHeader(): string {
  return Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");
}

function twilioSmsConfigured(): boolean {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER);
}

function twilioVerifyConfigured(): boolean {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SERVICE_SID);
}

function resendEmailConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

function maskTarget(target: string) {
  if (target.includes("@")) {
    const [user, domain] = target.split("@");
    if (!domain) return "***";
    return `${(user || "").slice(0, 2)}***@${domain}`;
  }
  const digits = target.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `***${digits.slice(-4)}`;
}

/** E.164 from stored target `phoneCode:phone` (e.g. `+91:9876543210`). */
function toE164(target: string): string {
  const [code, phone] = target.split(":");
  if (!phone) {
    const raw = target.replace(/\s+/g, "");
    return raw.startsWith("+") ? raw : `+${raw.replace(/\D/g, "")}`;
  }
  const digits = phone.replace(/\D/g, "");
  const cc = (code || "").replace(/\D/g, "");
  return `+${cc}${digits}`;
}

function deliveryUnavailable(message: string): never {
  throw new AppError(503, message, "OTP_DELIVERY_UNAVAILABLE");
}

class TwilioStartError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super("Twilio Verify start failed");
  }
}

function customCodeRejected(err: unknown): boolean {
  if (!(err instanceof TwilioStartError)) return false;
  return /custom.?code|60200|60322|60410/i.test(err.body);
}

async function startTwilioVerify(to: string, customCode?: string): Promise<void> {
  const sid = env.TWILIO_VERIFY_SERVICE_SID!;
  const params = new URLSearchParams({ To: to, Channel: "sms" });
  if (customCode) params.set("CustomCode", customCode);
  let res: Response;
  try {
    res = await fetch(`https://verify.twilio.com/v2/Services/${sid}/Verifications`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${twilioAuthHeader()}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
  } catch (err) {
    logger.error("Twilio Verify start network error", {
      to: maskTarget(to),
      err: err instanceof Error ? err.message : String(err),
    });
    deliveryUnavailable("Unable to send OTP SMS");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error("Twilio Verify start failed", {
      status: res.status,
      text: text.slice(0, 500),
      to: maskTarget(to),
      serviceSid: sid,
    });
    throw new TwilioStartError(res.status, text.slice(0, 500));
  }
  logger.info("Twilio Verify started", { to: maskTarget(to), status: res.status });
}

type TwilioCheck = "approved" | "mismatch" | "exhausted" | "unavailable";

async function checkTwilioVerify(to: string, code: string): Promise<TwilioCheck> {
  const sid = env.TWILIO_VERIFY_SERVICE_SID!;
  const params = new URLSearchParams({ To: to, Code: code });
  let res: Response;
  try {
    res = await fetch(`https://verify.twilio.com/v2/Services/${sid}/VerificationCheck`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${twilioAuthHeader()}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
  } catch (err) {
    logger.error("Twilio Verify check network error", {
      to: maskTarget(to),
      err: err instanceof Error ? err.message : String(err),
    });
    return "unavailable";
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error("Twilio Verify check failed", {
      status: res.status,
      text: text.slice(0, 500),
      to: maskTarget(to),
    });
    // 60202 max checks, 60203 max sends, 20404 verification already canceled/expired.
    if (/60202|60203|20404/.test(text)) return "exhausted";
    return "unavailable";
  }
  const data = (await res.json()) as { status?: string };
  if (data.status === "approved") return "approved";
  if (data.status === "canceled") return "exhausted";
  return "mismatch";
}

async function sendTwilioSms(to: string, body: string): Promise<void> {
  const sid = env.TWILIO_ACCOUNT_SID!;
  const from = env.TWILIO_FROM_NUMBER!;
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  let res: Response;
  try {
    res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${twilioAuthHeader()}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
  } catch (err) {
    logger.error("Twilio SMS network error", {
      to: maskTarget(to),
      err: err instanceof Error ? err.message : String(err),
    });
    deliveryUnavailable("Unable to send OTP SMS");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error("Twilio SMS failed", {
      status: res.status,
      text: text.slice(0, 500),
      to: maskTarget(to),
    });
    deliveryUnavailable("Unable to send OTP SMS");
  }
}

async function sendResendEmail(to: string, code: string, purpose?: OtpEmailPurpose): Promise<void> {
  const message = renderOtpEmail({
    code,
    purpose,
    expiresMinutes: Math.max(1, Math.round(env.OTP_TTL_SECONDS / 60)),
  });
  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });
  } catch (err) {
    logger.error("Resend email network error", {
      to: maskTarget(to),
      from: env.EMAIL_FROM,
      err: err instanceof Error ? err.message : String(err),
    });
    deliveryUnavailable("Unable to send OTP email");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error("Resend email failed", {
      status: res.status,
      text: text.slice(0, 500),
      to: maskTarget(to),
      from: env.EMAIL_FROM,
    });
    deliveryUnavailable("Unable to send OTP email");
  }
  logger.info("Resend email accepted", { to: maskTarget(to), status: res.status });
}

/**
 * Issue OTP.
 * Phone prefers our own code via Twilio Messages so a wrong guess does not
 * cancel the code at Twilio while the app countdown is still running.
 * Verify is the fallback when no From number is configured.
 * Email uses Resend when configured. Asset URLs in the template are always
 * https://listifys.com — never CLIENT_URL.
 */
export async function issueOtp(
  channel: "email" | "phone",
  target: string,
  purpose?: OtpEmailPurpose,
): Promise<{ expiresIn: number; delivery: OtpDelivery }> {
  let delivery: OtpDelivery;

  logger.info("OTP issue requested", {
    channel,
    target: maskTarget(target),
    providers: {
      twilioVerify: twilioVerifyConfigured(),
      twilioSms: twilioSmsConfigured(),
      resend: resendEmailConfigured(),
    },
  });

  if (channel === "phone") {
    const e164 = toE164(target);
    await clearOtpState(channel, target);

    if (twilioSmsConfigured()) {
      const code = String(randomInt(100000, 999999));
      await kv.set(otpKey(channel, target), code, env.OTP_TTL_SECONDS);
      await sendTwilioSms(e164, `Your Listifys verification code is ${code}`);
      logger.info("OTP issued", {
        channel,
        target: maskTarget(target),
        delivery: "sms",
      });
      return { expiresIn: env.OTP_TTL_SECONDS, delivery: "sms" };
    }

    if (twilioVerifyConfigured()) {
      const code = String(randomInt(100000, 999999));
      try {
        // Send our code through Verify so Twilio's own check limit cannot
        // cancel a still-valid code after a couple of wrong guesses.
        await startTwilioVerify(e164, code);
        await kv.set(otpKey(channel, target), code, env.OTP_TTL_SECONDS);
        logger.info("OTP issued via Twilio Verify custom code", {
          channel,
          target: maskTarget(target),
          delivery: "sms",
        });
        return { expiresIn: env.OTP_TTL_SECONDS, delivery: "sms" };
      } catch (err) {
        if (!customCodeRejected(err)) {
          deliveryUnavailable("Unable to send OTP SMS");
        }
        logger.warn("Twilio custom codes are disabled — using Verify checks", {
          target: maskTarget(target),
        });
        try {
          await startTwilioVerify(e164);
        } catch (fallbackErr) {
          logger.error("Twilio Verify fallback failed", {
            err: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          });
          deliveryUnavailable("Unable to send OTP SMS");
        }
        await kv.set(otpKey(channel, target), TWILIO_VERIFY_MARKER, env.OTP_TTL_SECONDS);
        logger.info("OTP issued via Twilio Verify", {
          channel,
          target: maskTarget(target),
          delivery: "sms",
        });
        return { expiresIn: env.OTP_TTL_SECONDS, delivery: "sms" };
      }
    }

    const code = String(randomInt(100000, 999999));
    await kv.set(otpKey(channel, target), code, env.OTP_TTL_SECONDS);

    if (env.NODE_ENV !== "production") {
      logger.info("OTP issued (dev — SMS provider not configured)", {
        channel,
        target: maskTarget(target),
        code,
      });
      delivery = "logged";
    } else {
      logger.error("OTP SMS delivery is not configured", {
        channel,
        target: maskTarget(target),
      });
      throw new AppError(503, "OTP SMS delivery is not configured", "OTP_DELIVERY_UNAVAILABLE");
    }
    return { expiresIn: env.OTP_TTL_SECONDS, delivery };
  }

  await clearOtpState(channel, target);
  const code = String(randomInt(100000, 999999));
  await kv.set(otpKey(channel, target), code, env.OTP_TTL_SECONDS);

  if (resendEmailConfigured()) {
    await sendResendEmail(target, code, purpose);
    delivery = "email";
    logger.info("OTP issued", {
      channel,
      target: maskTarget(target),
      delivery,
    });
  } else if (env.NODE_ENV !== "production") {
    logger.info("OTP issued (dev — email provider not configured)", {
      channel,
      target: maskTarget(target),
      code,
    });
    delivery = "logged";
  } else {
    logger.error("OTP email delivery is not configured", {
      channel,
      target: maskTarget(target),
    });
    throw new AppError(503, "OTP email delivery is not configured", "OTP_DELIVERY_UNAVAILABLE");
  }

  return { expiresIn: env.OTP_TTL_SECONDS, delivery };
}

async function registerFailedAttempt(channel: "email" | "phone", target: string): Promise<never> {
  const key = attemptsKey(channel, target);
  const current = Number((await kv.get(key)) || "0");
  const next = Number.isFinite(current) ? current + 1 : 1;
  if (next >= OTP_MAX_ATTEMPTS) {
    await kv.del(otpKey(channel, target));
    await kv.del(key);
    await kv.set(lockKey(channel, target), "1", env.OTP_TTL_SECONDS);
    attemptsExceeded();
  }
  await kv.set(key, String(next), env.OTP_TTL_SECONDS);
  throw new AppError(400, "Invalid or expired OTP", "INVALID_OTP");
}

/**
 * Check the code without deleting it. A wrong code stays valid until it
 * expires or the attempt limit is reached, so a later correct entry still works.
 */
export async function assertOtpValid(
  channel: "email" | "phone",
  target: string,
  code: string,
): Promise<void> {
  if (await kv.get(lockKey(channel, target))) {
    attemptsExceeded();
  }

  const stored = await kv.get(otpKey(channel, target));
  if (!stored) {
    throw new AppError(400, "Invalid or expired OTP", "INVALID_OTP");
  }

  const normalized = code.trim();

  if (stored === TWILIO_VERIFY_MARKER) {
    const result = await checkTwilioVerify(toE164(target), normalized);
    if (result === "approved") return;
    if (result === "unavailable") {
      throw new AppError(
        503,
        "Unable to verify the code right now. Try again.",
        "OTP_DELIVERY_UNAVAILABLE",
      );
    }
    if (result === "exhausted") {
      await kv.del(otpKey(channel, target));
      await kv.del(attemptsKey(channel, target));
      await kv.set(lockKey(channel, target), "1", env.OTP_TTL_SECONDS);
      attemptsExceeded();
    }
    await registerFailedAttempt(channel, target);
  }

  if (stored !== normalized) {
    await registerFailedAttempt(channel, target);
  }
}

export async function consumeOtp(channel: "email" | "phone", target: string): Promise<void> {
  await kv.del(otpKey(channel, target));
  await kv.del(attemptsKey(channel, target));
  await kv.del(lockKey(channel, target));
}

export async function verifyOtp(
  channel: "email" | "phone",
  target: string,
  code: string,
): Promise<void> {
  await assertOtpValid(channel, target, code);
  await consumeOtp(channel, target);
}
