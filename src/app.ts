import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import cookieParser from "cookie-parser";
import { getAllowedOrigins, isOriginAllowed, isProd } from "./config/origins.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { attachMarket } from "./middleware/market.js";
import { optionalAuth } from "./middleware/auth.js";
import { globalRateLimit } from "./middleware/rateLimit.js";
import { healthRouter } from "./modules/health/health.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { listingsRouter } from "./modules/listings/listing.routes.js";
import { legacyImagesRouter, mediaRouter } from "./modules/media/media.routes.js";
import { usersRouter } from "./modules/users/users.routes.js";
import { savedRouter } from "./modules/saved/saved.routes.js";
import { compareRouter } from "./modules/compare/compare.routes.js";
import { chatRouter } from "./modules/chat/chat.routes.js";
import { notificationsRouter } from "./modules/notifications/notification.routes.js";
import { placesRouter } from "./modules/places/places.routes.js";
import { boostRouter } from "./modules/boost/boost.routes.js";
import { paymentsRouter } from "./modules/payments/payments.routes.js";
import { webhooksRouter } from "./modules/payments/webhooks.routes.js";
import { premiumRouter } from "./modules/premium/premium.routes.js";
import { eventTicketsRouter } from "./modules/event-tickets/eventTickets.routes.js";
import { reviewsRouter } from "./modules/reviews/reviews.routes.js";
import { offersRouter } from "./modules/offers/offers.routes.js";
import { reportsRouter } from "./modules/admin/reports.routes.js";
import { appPublicRouter } from "./modules/admin/app.routes.js";
import { adminRouter } from "./modules/admin/admin.routes.js";
import { logger } from "./utils/logger.js";

export function createApp() {
  const app = express();

  app.set("trust proxy", 1);
  app.use(
    helmet(
      isProd()
        ? {
            crossOriginResourcePolicy: { policy: "cross-origin" },
          }
        : undefined,
    ),
  );
  app.use(
    cors({
      origin: (origin, cb) => {
        if (isOriginAllowed(origin)) return cb(null, true);
        logger.warn("CORS blocked origin", { origin });
        return cb(null, false);
      },
      credentials: true,
    }),
  );
  if (isProd()) {
    logger.info("CORS allowlist (production)", {
      origins: getAllowedOrigins(),
    });
  }
  app.use(compression());

  // Webhooks need raw body for HMAC — mount before JSON parser
  app.use("/api/webhooks", webhooksRouter);

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(requestLogger);
  // Attach userId when a valid token is present so rate limits key per user
  // (avoids shared office/NAT IPs exhausting one bucket during team testing).
  app.use(optionalAuth);
  app.use(globalRateLimit);
  app.use(attachMarket);

  app.use("/health", healthRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/listings", listingsRouter);
  app.use("/api/saved", savedRouter);
  app.use("/api/compare", compareRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/media", mediaRouter);
  app.use("/api/images", legacyImagesRouter);
  app.use("/api/places", placesRouter);
  app.use("/api/boost", boostRouter);
  app.use("/api/premium", premiumRouter);
  app.use("/api/events", eventTicketsRouter);
  app.use("/api/seller-reviews", reviewsRouter);
  app.use("/api/offers", offersRouter);
  app.use("/api/payments", paymentsRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/app", appPublicRouter);
  app.use("/api/admin", adminRouter);

  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  });

  app.use(errorHandler);
  return app;
}
