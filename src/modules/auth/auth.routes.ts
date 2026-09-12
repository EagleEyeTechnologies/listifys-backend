import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { authRateLimit } from "../../middleware/rateLimit.js";
import {
  emailLoginSchema,
  emailRegisterSchema,
  emailRequestSchema,
  emailResetPasswordSchema,
  emailVerifySchema,
  loginWithEmail,
  logout,
  phoneRequestSchema,
  phoneVerifySchema,
  refreshSchema,
  refreshSession,
  registerWithEmail,
  requestEmailOtp,
  requestPasswordResetOtp,
  requestPhoneOtp,
  resetPasswordWithOtp,
  socialLogin,
  socialSchema,
  verifyEmailOtp,
  verifyPhoneOtp,
} from "./auth.service.js";
import { AppError } from "../../utils/AppError.js";
import { env } from "../../config/env.js";

export const authRouter = Router();

authRouter.use(authRateLimit);

function setAuthCookies(
  res: import("express").Response,
  accessToken: string,
  refreshToken: string,
) {
  const secure = env.NODE_ENV === "production";
  res.cookie("accessToken", accessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: 60 * 60 * 1000,
  });
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const parsed = emailRegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await registerWithEmail(parsed.data);
    setAuthCookies(res, data.accessToken, data.refreshToken);
    res.status(201).json({ success: true, data });
  }),
);

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const parsed = emailLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await loginWithEmail(parsed.data);
    setAuthCookies(res, data.accessToken, data.refreshToken);
    res.json({ success: true, data });
  }),
);

authRouter.post(
  "/password/forgot",
  asyncHandler(async (req, res) => {
    const parsed = emailRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid email", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const result = await requestPasswordResetOtp(parsed.data.email);
    res.json({ success: true, data: result });
  }),
);

authRouter.post(
  "/password/reset",
  asyncHandler(async (req, res) => {
    const parsed = emailResetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await resetPasswordWithOtp(parsed.data);
    setAuthCookies(res, data.accessToken, data.refreshToken);
    res.json({ success: true, data });
  }),
);

authRouter.post(
  "/otp/email/request",
  asyncHandler(async (req, res) => {
    const parsed = emailRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid email", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const result = await requestEmailOtp(parsed.data.email);
    res.json({ success: true, data: result });
  }),
);

authRouter.post(
  "/otp/email/verify",
  asyncHandler(async (req, res) => {
    const parsed = emailVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await verifyEmailOtp(parsed.data);
    setAuthCookies(res, data.accessToken, data.refreshToken);
    res.json({ success: true, data });
  }),
);

authRouter.post(
  "/otp/phone/request",
  asyncHandler(async (req, res) => {
    const parsed = phoneRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid phone", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const result = await requestPhoneOtp(parsed.data.phone, parsed.data.phoneCode);
    res.json({ success: true, data: result });
  }),
);

authRouter.post(
  "/otp/phone/verify",
  asyncHandler(async (req, res) => {
    const parsed = phoneVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await verifyPhoneOtp(parsed.data);
    setAuthCookies(res, data.accessToken, data.refreshToken);
    res.json({ success: true, data });
  }),
);

authRouter.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const bodyToken = refreshSchema.safeParse(req.body);
    const cookieToken = (req as typeof req & { cookies?: Record<string, string> })
      .cookies?.refreshToken;
    const refreshToken = bodyToken.success
      ? bodyToken.data.refreshToken
      : cookieToken;
    if (!refreshToken) {
      throw new AppError(400, "refreshToken required", "VALIDATION_ERROR");
    }
    const data = await refreshSession(refreshToken);
    setAuthCookies(res, data.accessToken, data.refreshToken);
    res.json({ success: true, data });
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const bodyToken = refreshSchema.safeParse(req.body);
    const cookieToken = (req as typeof req & { cookies?: Record<string, string> })
      .cookies?.refreshToken;
    await logout(bodyToken.success ? bodyToken.data.refreshToken : cookieToken);
    res.clearCookie("accessToken");
    res.clearCookie("refreshToken");
    res.json({ success: true });
  }),
);

authRouter.post(
  "/google",
  asyncHandler(async (req, res) => {
    const parsed = socialSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await socialLogin("google", parsed.data);
    setAuthCookies(res, data.accessToken, data.refreshToken);
    res.json({ success: true, data });
  }),
);

authRouter.post(
  "/apple",
  asyncHandler(async (req, res) => {
    const parsed = socialSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }
    const data = await socialLogin("apple", parsed.data);
    setAuthCookies(res, data.accessToken, data.refreshToken);
    res.json({ success: true, data });
  }),
);
