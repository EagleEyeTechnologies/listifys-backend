import { randomUUID } from "crypto";
import { z } from "zod";
import * as argon2 from "argon2";
import { User } from "../users/user.model.js";
import { issueOtp, verifyOtp } from "./otp.js";
import {
  isRefreshTokenValid,
  issueTokenPair,
  revokeRefreshToken,
  storeRefreshToken,
  verifyRefreshToken,
} from "./tokens.js";
import { AppError } from "../../utils/AppError.js";
import { absolutizeMediaUrl } from "../../utils/mediaUrl.js";
import {
  assertValidNationalPhone,
  displayEmail,
  isApplePrivateRelayEmail,
  needsPublicEmail,
  normalizePhoneParts,
} from "../../utils/phone.js";
import type { CountryCode } from "../../types/domain.js";
import {
  verifyAppleIdentityToken,
  verifyGoogleAccessToken,
  verifyGoogleIdToken,
} from "./social.oauth.js";

export const emailRequestSchema = z.object({
  email: z.string().email(),
});

export const emailVerifySchema = z.object({
  email: z.string().email(),
  code: z.string().min(4).max(8),
  name: z.string().optional(),
  countryCode: z.enum(["US", "CA", "IN"]).optional(),
});

export const emailRegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(100),
  code: z.string().min(4).max(8),
  countryCode: z.enum(["US", "CA", "IN"]).optional(),
});

export const emailLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});

export const emailResetPasswordSchema = z.object({
  email: z.string().email(),
  code: z.string().min(4).max(8),
  password: z.string().min(8).max(128),
});

export const phoneRequestSchema = z.object({
  phone: z.string().min(8).max(20),
  phoneCode: z.string().min(1).max(5).default("+91"),
  purpose: z.enum(["login", "register"]).optional(),
});

export const phoneVerifySchema = z.object({
  phone: z.string().min(8).max(20),
  phoneCode: z.string().min(1).max(5).default("+91"),
  code: z.string().min(4).max(8),
  name: z.string().optional(),
  countryCode: z.enum(["US", "CA", "IN"]).optional(),
  purpose: z.enum(["login", "register"]).optional(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

export const socialSchema = z
  .object({
    idToken: z.string().min(10).optional(),
    accessToken: z.string().min(10).optional(),
    name: z.string().optional(),
    email: z.string().email().optional(),
    givenName: z.string().optional(),
    familyName: z.string().optional(),
    countryCode: z.enum(["US", "CA", "IN"]).optional(),
  })
  .refine((value) => Boolean(value.idToken || value.accessToken), {
    message: "A Google or Apple token is required",
  });

function publicUser(user: {
  _id: { toString(): string };
  email?: string | null;
  phone?: string | null;
  phoneCode?: string | null;
  name?: string | null;
  avatar?: string | null;
  countryCode?: CountryCode;
}) {
  const emailShown = displayEmail(user.email);
  return {
    id: user._id.toString(),
    email: emailShown === "—" ? null : emailShown,
    phone: user.phone || null,
    phoneCode: user.phoneCode || null,
    name: user.name || "",
    avatar: absolutizeMediaUrl(user.avatar),
    countryCode: user.countryCode || "IN",
  };
}

async function tokensFor(userId: string) {
  const jti = randomUUID();
  await storeRefreshToken(userId, jti);
  return issueTokenPair(userId, jti);
}

async function hashPassword(password: string) {
  return argon2.hash(password, { type: argon2.argon2id });
}

async function verifyPassword(hash: string, password: string) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Email register: requires a prior OTP from requestRegisterEmailOtp. */
export async function registerWithEmail(input: z.infer<typeof emailRegisterSchema>) {
  const email = input.email.trim().toLowerCase();
  await verifyOtp("email", email, input.code);

  const existing = await User.findOne({ email }).select("+passwordHash");
  if (existing?.passwordHash) {
    throw new AppError(409, "Email already registered. Please sign in.", "EMAIL_EXISTS");
  }

  const passwordHash = await hashPassword(input.password);

  if (existing) {
    existing.passwordHash = passwordHash;
    if (input.name && !existing.name) existing.name = input.name;
    if (input.countryCode) existing.countryCode = input.countryCode;
    if (!existing.providers?.some((p) => p.provider === "email")) {
      existing.providers.push({ provider: "email", providerId: email });
    }
    await existing.save();
    const tokens = await tokensFor(existing._id.toString());
    return { user: publicUser(existing), ...tokens };
  }

  const user = await User.create({
    email,
    name: input.name.trim(),
    passwordHash,
    countryCode: input.countryCode || "IN",
    providers: [{ provider: "email", providerId: email }],
  });
  const tokens = await tokensFor(user._id.toString());
  return { user: publicUser(user), ...tokens };
}

/** Send OTP before creating an email+password account. */
export async function requestRegisterEmailOtp(emailRaw: string) {
  const email = emailRaw.trim().toLowerCase();
  const existing = await User.findOne({ email }).select("+passwordHash");
  if (existing?.passwordHash) {
    throw new AppError(409, "Email already registered. Please sign in.", "EMAIL_EXISTS");
  }
  return issueOtp("email", email, "register");
}

/** Email login with password. */
export async function loginWithEmail(input: z.infer<typeof emailLoginSchema>) {
  const email = input.email.trim().toLowerCase();
  const user = await User.findOne({ email }).select("+passwordHash");
  if (!user || !user.isActive) {
    throw new AppError(401, "Invalid email or password", "INVALID_CREDENTIALS");
  }
  if (!user.passwordHash) {
    throw new AppError(
      400,
      "This account has no password yet. Use Forgot password to set one, or sign in with Google / phone OTP.",
      "PASSWORD_NOT_SET",
    );
  }
  const ok = await verifyPassword(user.passwordHash, input.password);
  if (!ok) {
    throw new AppError(401, "Invalid email or password", "INVALID_CREDENTIALS");
  }
  const tokens = await tokensFor(user._id.toString());
  return { user: publicUser(user), ...tokens };
}

/** Request OTP for password reset (email only). */
export async function requestPasswordResetOtp(email: string) {
  const normalized = email.trim().toLowerCase();
  const user = await User.findOne({ email: normalized });
  if (!user) {
    // Do not leak whether the email exists
    return { expiresIn: 300 };
  }
  return issueOtp("email", normalized, "password_reset");
}

/** Verify OTP and set a new password. */
export async function resetPasswordWithOtp(input: z.infer<typeof emailResetPasswordSchema>) {
  const email = input.email.trim().toLowerCase();
  await verifyOtp("email", email, input.code);
  const user = await User.findOne({ email }).select("+passwordHash +passwordHistory");
  if (!user || !user.isActive) {
    throw new AppError(404, "User not found", "NOT_FOUND");
  }
  const history = (user.passwordHistory || []).filter((hash) => Boolean(hash));
  const recent = [user.passwordHash, ...history]
    .filter((hash): hash is string => Boolean(hash))
    .slice(0, 3);
  for (const hash of recent) {
    if (await verifyPassword(hash, input.password)) {
      throw new AppError(
        400,
        "Choose a password that is not one of your last 3 passwords.",
        "PASSWORD_REUSED",
      );
    }
  }
  if (user.passwordHash) {
    user.passwordHistory = [user.passwordHash, ...history].slice(0, 2);
  }
  user.passwordHash = await hashPassword(input.password);
  if (!user.providers?.some((p) => p.provider === "email")) {
    user.providers.push({ provider: "email", providerId: email });
  }
  await user.save();
  const tokens = await tokensFor(user._id.toString());
  return { user: publicUser(user), ...tokens };
}

/** @deprecated Prefer email+password. Kept for transitional clients. */
export async function requestEmailOtp(email: string) {
  const normalized = email.trim().toLowerCase();
  return issueOtp("email", normalized, "login");
}

/** @deprecated Prefer email+password. Kept for transitional clients. */
export async function verifyEmailOtp(input: z.infer<typeof emailVerifySchema>) {
  const email = input.email.trim().toLowerCase();
  await verifyOtp("email", email, input.code);

  let user = await User.findOne({ email });
  if (!user) {
    user = await User.create({
      email,
      name: input.name || email.split("@")[0],
      countryCode: input.countryCode || "IN",
      providers: [{ provider: "email", providerId: email }],
    });
  } else if (!user.providers?.some((p) => p.provider === "email")) {
    user.providers.push({ provider: "email", providerId: email });
    if (input.name && !user.name) user.name = input.name;
    if (input.countryCode) user.countryCode = input.countryCode;
    await user.save();
  }

  const tokens = await tokensFor(user._id.toString());
  return { user: publicUser(user), ...tokens };
}

async function findUserByPhone(phoneCode: string, phone: string, rawPhone?: string) {
  const parts = normalizePhoneParts(phoneCode, phone);
  const code = parts.phoneCode || phoneCode;
  const national = parts.phone || phone;
  return (
    (await User.findOne({ phone: national, phoneCode: code })) ||
    (rawPhone ? await User.findOne({ phone: rawPhone }) : null) ||
    (await User.findOne({ phone: national })) ||
    (await User.findOne({ phone: `${code}${national}` })) ||
    (await User.findOne({ phone: `+${code.replace("+", "")}${national}` }))
  );
}

function phoneNotRegistered() {
  return new AppError(
    404,
    "This mobile number is not registered. Please create an account.",
    "PHONE_NOT_REGISTERED",
  );
}

export async function requestPhoneOtp(
  phone: string,
  phoneCode: string,
  purpose: "login" | "register" = "login",
) {
  let normalized: { phoneCode: string; phone: string };
  try {
    normalized = assertValidNationalPhone(phoneCode, phone);
  } catch (err) {
    throw new AppError(
      400,
      err instanceof Error ? err.message : "Invalid phone number",
      "VALIDATION_ERROR",
    );
  }

  const existing = await findUserByPhone(normalized.phoneCode, normalized.phone, phone);

  if (purpose === "register") {
    if (existing) {
      throw new AppError(
        409,
        "This mobile number is already registered. Please sign in.",
        "PHONE_EXISTS",
      );
    }
  } else if (!existing) {
    throw phoneNotRegistered();
  }

  return issueOtp("phone", `${normalized.phoneCode}:${normalized.phone}`);
}

export async function verifyPhoneOtp(input: z.infer<typeof phoneVerifySchema>) {
  let normalized: { phoneCode: string; phone: string };
  try {
    normalized = assertValidNationalPhone(input.phoneCode, input.phone);
  } catch (err) {
    throw new AppError(
      400,
      err instanceof Error ? err.message : "Invalid phone number",
      "VALIDATION_ERROR",
    );
  }
  const target = `${normalized.phoneCode}:${normalized.phone}`;
  await verifyOtp("phone", target, input.code);

  const parts = normalizePhoneParts(normalized.phoneCode, normalized.phone);
  const phoneCode = parts.phoneCode || normalized.phoneCode;
  const phone = parts.phone || normalized.phone;
  const purpose = input.purpose === "register" ? "register" : "login";

  let user = await findUserByPhone(phoneCode, phone, input.phone);

  if (purpose === "register" && user) {
    throw new AppError(
      409,
      "This mobile number is already registered. Please sign in.",
      "PHONE_EXISTS",
    );
  }

  if (!user && purpose === "login") {
    throw phoneNotRegistered();
  }

  if (!user) {
    user = await User.create({
      phone,
      phoneCode,
      name: input.name || `User ${phone.slice(-4)}`,
      countryCode: input.countryCode || "IN",
      providers: [{ provider: "phone", providerId: `${phoneCode}:${phone}` }],
    });
  } else {
    if (!user.providers?.some((p) => p.provider === "phone")) {
      user.providers.push({
        provider: "phone",
        providerId: `${phoneCode}:${phone}`,
      });
    }
    user.phone = phone;
    user.phoneCode = phoneCode;
    if (input.name && !user.name) user.name = input.name;
    if (input.countryCode) user.countryCode = input.countryCode;
    await user.save();
  }

  const tokens = await tokensFor(user._id.toString());
  return { user: publicUser(user), ...tokens };
}

export async function refreshSession(refreshToken: string) {
  const payload = verifyRefreshToken(refreshToken);
  const ok = await isRefreshTokenValid(payload.sub, payload.jti);
  if (!ok) throw new AppError(401, "Refresh token revoked", "UNAUTHORIZED");
  await revokeRefreshToken(payload.sub, payload.jti);
  const tokens = await tokensFor(payload.sub);
  const user = await User.findById(payload.sub);
  if (!user || !user.isActive) {
    throw new AppError(401, "User not found", "UNAUTHORIZED");
  }
  return { user: publicUser(user), ...tokens };
}

export async function logout(refreshToken?: string) {
  if (!refreshToken) return;
  try {
    const payload = verifyRefreshToken(refreshToken);
    await revokeRefreshToken(payload.sub, payload.jti);
  } catch {
    // ignore invalid token on logout
  }
}

export async function socialLogin(
  provider: "google" | "apple",
  input: z.infer<typeof socialSchema>,
) {
  if (provider === "google") {
    const identity = input.idToken
      ? await verifyGoogleIdToken(input.idToken)
      : await verifyGoogleAccessToken(input.accessToken || "");
    const email = identity.email;

    let user = await User.findOne({
      $or: [
        {
          providers: {
            $elemMatch: {
              provider: "google",
              providerId: identity.googleId,
            },
          },
        },
        { email },
      ],
    });

    if (user) {
      if (!user.providers?.some((p) => p.provider === "google")) {
        user.providers.push({
          provider: "google",
          providerId: identity.googleId,
        });
      }
      if (identity.picture && !user.avatar) user.avatar = identity.picture;
      if (identity.name && !user.name) user.name = identity.name;
      if (input.countryCode) user.countryCode = input.countryCode;
      if (!user.email) user.email = email;
      await user.save();
    } else {
      user = await User.create({
        email,
        name: identity.name || input.name || email.split("@")[0],
        avatar: identity.picture || "",
        countryCode: input.countryCode || "IN",
        providers: [{ provider: "google", providerId: identity.googleId }],
      });
    }

    const tokens = await tokensFor(user._id.toString());
    return { user: publicUser(user), ...tokens };
  }

  if (!input.idToken) {
    throw new AppError(400, "Apple identity token is required", "VALIDATION_ERROR");
  }
  const identity = await verifyAppleIdentityToken(input.idToken);
  const displayName =
    [input.givenName, input.familyName].filter(Boolean).join(" ").trim() ||
    input.name ||
    (identity.email ? identity.email.split("@")[0] : "Apple User");

  let user = await User.findOne({
    $or: [
      {
        providers: {
          $elemMatch: {
            provider: "apple",
            providerId: identity.appleId,
          },
        },
      },
      ...(identity.email ? [{ email: identity.email }] : []),
    ],
  });

  if (user) {
    if (!user.providers?.some((p) => p.provider === "apple")) {
      user.providers.push({
        provider: "apple",
        providerId: identity.appleId,
      });
    }
    if (displayName && displayName !== "Apple User" && (!user.name || user.name === "Apple User")) {
      user.name = displayName;
    }
    if (identity.email && !user.email) user.email = identity.email;
    if (input.countryCode) user.countryCode = input.countryCode;
    await user.save();
  } else {
    // Prefer Apple-provided email (public or Hide My Email relay). Client will
    // prompt for a real inbox when the address is a private relay.
    const email =
      identity.email ||
      input.email?.trim().toLowerCase() ||
      `apple.${identity.appleId}@users.listifys.app`;
    user = await User.create({
      email,
      name: displayName,
      countryCode: input.countryCode || "IN",
      providers: [{ provider: "apple", providerId: identity.appleId }],
    });
  }

  const tokens = await tokensFor(user._id.toString());
  return {
    user: publicUser(user),
    ...tokens,
    needsEmail: needsPublicEmail(user.email),
    isPrivateEmail: isApplePrivateRelayEmail(user.email),
  };
}
