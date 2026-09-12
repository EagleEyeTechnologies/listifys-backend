import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { env } from "../config/env.js";

const countrySchema = z.enum(["US", "CA", "IN"]);

declare global {
  namespace Express {
    interface Request {
      countryCode: "US" | "CA" | "IN";
    }
  }
}

export function attachMarket(req: Request, _res: Response, next: NextFunction) {
  const raw =
    (req.headers["x-country-code"] as string | undefined) ||
    (req.query.countryCode as string | undefined) ||
    env.DEFAULT_COUNTRY_CODE;
  const parsed = countrySchema.safeParse(String(raw).toUpperCase());
  req.countryCode = parsed.success ? parsed.data : env.DEFAULT_COUNTRY_CODE;
  next();
}
