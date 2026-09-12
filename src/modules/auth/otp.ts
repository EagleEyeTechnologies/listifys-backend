import { randomInt } from "crypto";
import { env } from "../../config/env.js";
import { kv } from "../../redis/client.js";
import { logger } from "../../utils/logger.js";
import { AppError } from "../../utils/AppError.js";

export type OtpDelivery = "logged" | "sms" | "email" | "unavailable";

const TWILIO_VERIFY_MARKER = "twilio-verify";

function otpKey(channel: "email" | "phone", target: string) {
  return `otp:${channel}:${target}`;
}

function twilioAuthHeader(): string {
  return Buffer.from(
    `${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`,
  ).toString("base64");
}

function twilioSmsConfigured(): boolean {
  return Boolean(
    env.TWILIO_ACCOUNT_SID &&
      env.TWILIO_AUTH_TOKEN &&
      env.TWILIO_FROM_NUMBER,
  );
}

function twilioVerifyConfigured(): boolean {
  return Boolean(
    env.TWILIO_ACCOUNT_SID &&
      env.TWILIO_AUTH_TOKEN &&
      env.TWILIO_VERIFY_SERVICE_SID,
  );
}

function resendEmailConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
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

async function startTwilioVerify(to: string): Promise<void> {
  const sid = env.TWILIO_VERIFY_SERVICE_SID!;
  const params = new URLSearchParams({ To: to, Channel: "sms" });
  const res = await fetch(
    `https://verify.twilio.com/v2/Services/${sid}/Verifications`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${twilioAuthHeader()}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error("Twilio Verify start failed", { status: res.status, text });
    throw new AppError(
      503,
      "Unable to send OTP SMS",
      "OTP_DELIVERY_UNAVAILABLE",
    );
  }
}

async function checkTwilioVerify(to: string, code: string): Promise<boolean> {
  const sid = env.TWILIO_VERIFY_SERVICE_SID!;
  const params = new URLSearchParams({ To: to, Code: code });
  const res = await fetch(
    `https://verify.twilio.com/v2/Services/${sid}/VerificationCheck`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${twilioAuthHeader()}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error("Twilio Verify check failed", { status: res.status, text });
    return false;
  }
  const data = (await res.json()) as { status?: string };
  return data.status === "approved";
}

async function sendTwilioSms(to: string, body: string): Promise<void> {
  const sid = env.TWILIO_ACCOUNT_SID!;
  const from = env.TWILIO_FROM_NUMBER!;
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${twilioAuthHeader()}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error("Twilio SMS failed", { status: res.status, text });
    throw new AppError(
      503,
      "Unable to send OTP SMS",
      "OTP_DELIVERY_UNAVAILABLE",
    );
  }
}

async function sendResendEmail(to: string, code: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [to],
      subject: "Your Listifys verification code",
      text: `Your Listifys verification code is ${code}. It expires in ${Math.round(env.OTP_TTL_SECONDS / 60)} minutes.`,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error("Resend email failed", { status: res.status, text });
    throw new AppError(
      503,
      "Unable to send OTP email",
      "OTP_DELIVERY_UNAVAILABLE",
    );
  }
}

/**
 * Issue OTP.
 * Phone prefers Twilio Verify (legacy config), then Messages API, then dev log.
 * Email uses Resend when configured.
 */
export async function issueOtp(
  channel: "email" | "phone",
  target: string,
): Promise<{ expiresIn: number; delivery: OtpDelivery }> {
  let delivery: OtpDelivery = "unavailable";

  if (channel === "phone") {
    const e164 = toE164(target);
    if (twilioVerifyConfigured()) {
      await startTwilioVerify(e164);
      await kv.set(
        otpKey(channel, target),
        TWILIO_VERIFY_MARKER,
        env.OTP_TTL_SECONDS,
      );
      delivery = "sms";
      logger.info("OTP issued via Twilio Verify", { channel, target, delivery });
      return { expiresIn: env.OTP_TTL_SECONDS, delivery };
    }

    const code = String(randomInt(100000, 999999));
    await kv.set(otpKey(channel, target), code, env.OTP_TTL_SECONDS);

    if (twilioSmsConfigured()) {
      await sendTwilioSms(e164, `Your Listifys verification code is ${code}`);
      delivery = "sms";
      logger.info("OTP issued", { channel, target, delivery });
    } else if (env.NODE_ENV !== "production") {
      logger.info("OTP issued (dev — SMS provider not configured)", {
        channel,
        target,
        code,
      });
      delivery = "logged";
    } else {
      throw new AppError(
        503,
        "OTP SMS delivery is not configured",
        "OTP_DELIVERY_UNAVAILABLE",
      );
    }
    return { expiresIn: env.OTP_TTL_SECONDS, delivery };
  }

  const code = String(randomInt(100000, 999999));
  await kv.set(otpKey(channel, target), code, env.OTP_TTL_SECONDS);

  if (resendEmailConfigured()) {
    await sendResendEmail(target, code);
    delivery = "email";
    logger.info("OTP issued", { channel, target, delivery });
  } else if (env.NODE_ENV !== "production") {
    logger.info("OTP issued (dev — email provider not configured)", {
      channel,
      target,
      code,
    });
    delivery = "logged";
  } else {
    throw new AppError(
      503,
      "OTP email delivery is not configured",
      "OTP_DELIVERY_UNAVAILABLE",
    );
  }

  return { expiresIn: env.OTP_TTL_SECONDS, delivery };
}

export async function verifyOtp(
  channel: "email" | "phone",
  target: string,
  code: string,
): Promise<void> {
  const stored = await kv.get(otpKey(channel, target));
  if (!stored) {
    throw new AppError(400, "Invalid or expired OTP", "INVALID_OTP");
  }

  if (stored === TWILIO_VERIFY_MARKER) {
    const ok = await checkTwilioVerify(toE164(target), code);
    if (!ok) {
      throw new AppError(400, "Invalid or expired OTP", "INVALID_OTP");
    }
    await kv.del(otpKey(channel, target));
    return;
  }

  if (stored !== code) {
    throw new AppError(400, "Invalid or expired OTP", "INVALID_OTP");
  }
  await kv.del(otpKey(channel, target));
}
