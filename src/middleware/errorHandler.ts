import type { NextFunction, Request, Response } from "express";
import { AppError } from "../utils/AppError.js";
import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof AppError) {
    // Always surface delivery / auth failures in logs (otp.ts also logs provider bodies).
    if (
      err.statusCode >= 500 ||
      err.code === "OTP_DELIVERY_UNAVAILABLE" ||
      err.code === "INTERNAL_ERROR"
    ) {
      logger.error("Request failed", {
        code: err.code,
        message: err.message,
        statusCode: err.statusCode,
        details: err.details,
      });
    }
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  logger.error("Unhandled error", {
    err: err instanceof Error ? { message: err.message, stack: err.stack } : err,
  });

  const message =
    env.NODE_ENV === "production"
      ? "Internal server error"
      : err instanceof Error
        ? err.message
        : "Internal server error";

  return res.status(500).json({
    success: false,
    error: { code: "INTERNAL_ERROR", message },
  });
}
