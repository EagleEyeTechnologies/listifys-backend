import { Router } from "express";
import { env } from "../../config/env.js";
import { isProd } from "../../config/origins.js";
import { mongoReady } from "../../db/mongo.js";
import { redisReady, redisBackend } from "../../redis/client.js";
import { fcmReady } from "../notifications/fcm.service.js";
import { elasticsearchReady } from "../search/search.service.js";
import { s3Configured } from "../media/s3.js";

export const healthRouter = Router();

function paymentsStatus() {
  return {
    razorpay: Boolean(env.RAZORPAY_ENABLED && env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET),
    stripe: Boolean(env.STRIPE_ENABLED && env.STRIPE_SECRET_KEY && env.STRIPE_PUBLISHABLE_KEY),
  };
}

function otpProviders() {
  return {
    twilioSms: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER),
    twilioVerify: Boolean(env.TWILIO_VERIFY_SERVICE_SID),
    resend: Boolean(env.RESEND_API_KEY && env.EMAIL_FROM),
  };
}

/** Liveness — process is up (use for load balancer ping). */
healthRouter.get("/live", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "listifys-api",
    env: env.NODE_ENV,
    uptimeSec: Math.round(process.uptime()),
    time: new Date().toISOString(),
  });
});

/** Readiness — can serve authenticated marketplace traffic. */
healthRouter.get("/ready", (_req, res) => {
  const mongo = mongoReady();
  const redis = redisReady();
  const s3 = s3Configured();
  const fcm = fcmReady();
  const elasticsearch = elasticsearchReady();
  const payments = paymentsStatus();
  const otp = otpProviders();

  // Mongo is required. Redis recommended (sessions/OTP). S3 required in production.
  const ready = mongo && (!isProd() || s3);
  const status = ready ? 200 : 503;

  res.status(status).json({
    ok: ready,
    service: "listifys-api",
    env: env.NODE_ENV,
    checks: {
      mongo,
      redis,
      redisBackend: redisBackend(),
      s3,
      fcm,
      elasticsearch,
      payments,
      otp,
    },
    time: new Date().toISOString(),
  });
});

/** Back-compat summary (used by website checkApiHealth). */
healthRouter.get("/", (_req, res) => {
  const mongo = mongoReady();
  const redis = redisReady();
  const s3 = s3Configured();
  const ok = mongo && (!isProd() || s3);
  res.status(ok ? 200 : 503).json({
    ok,
    mongo,
    redis,
    s3,
    fcm: fcmReady(),
    elasticsearch: elasticsearchReady(),
    service: "listifys-api",
    time: new Date().toISOString(),
  });
});
