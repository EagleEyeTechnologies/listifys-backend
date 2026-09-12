/**
 * FCM push via Firebase Admin (modular SDK).
 */
import path from "path";
import fs from "fs";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

let app: App | null = null;
let initAttempted = false;

function stringifyData(obj: Record<string, unknown> = {}) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

function resolveServiceAccount(): Record<string, unknown> | null {
  const saPathRaw =
    env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    (env.FIREBASE_SERVICE_ACCOUNT_JSON &&
    !env.FIREBASE_SERVICE_ACCOUNT_JSON.trim().startsWith("{")
      ? env.FIREBASE_SERVICE_ACCOUNT_JSON
      : null);

  if (saPathRaw) {
    const candidates = [
      path.isAbsolute(saPathRaw) ? saPathRaw : null,
      path.join(process.cwd(), saPathRaw),
      path.join(process.cwd(), "..", "..", "old-code", "server", saPathRaw),
      path.join(
        process.cwd(),
        "..",
        "..",
        "old-code",
        "server",
        "config",
        "firebase-service-account.json",
      ),
    ].filter(Boolean) as string[];
    const resolved = candidates.find((p) => fs.existsSync(p));
    if (!resolved) return null;
    return JSON.parse(fs.readFileSync(resolved, "utf8")) as Record<
      string,
      unknown
    >;
  }

  if (
    env.FIREBASE_SERVICE_ACCOUNT_JSON &&
    env.FIREBASE_SERVICE_ACCOUNT_JSON.trim().startsWith("{")
  ) {
    return JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON) as Record<
      string,
      unknown
    >;
  }

  if (
    env.FIREBASE_PROJECT_ID &&
    env.FIREBASE_CLIENT_EMAIL &&
    env.FIREBASE_PRIVATE_KEY
  ) {
    return {
      project_id: env.FIREBASE_PROJECT_ID,
      client_email: env.FIREBASE_CLIENT_EMAIL,
      private_key: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    };
  }

  return null;
}

function ensureApp(): App | null {
  if (app) return app;
  if (initAttempted) return null;
  initAttempted = true;

  try {
    const existing = getApps();
    if (existing.length > 0) {
      app = existing[0]!;
      logger.info("[FCM] Firebase Admin SDK initialized");
      return app;
    }

    const serviceAccount = resolveServiceAccount();
    if (!serviceAccount) {
      logger.warn("[FCM] No Firebase credentials — device push disabled");
      return null;
    }

    app = initializeApp({
      credential: cert(serviceAccount as Parameters<typeof cert>[0]),
    });
    logger.info("[FCM] Firebase Admin SDK initialized");
    return app;
  } catch (err) {
    logger.error("[FCM] Failed to initialize Firebase Admin SDK", {
      error: err instanceof Error ? err.message : String(err),
    });
    app = null;
    return null;
  }
}

export function fcmReady(): boolean {
  return Boolean(ensureApp());
}

export async function sendFcmToTokens(
  tokens: string[],
  payload: {
    title: string;
    body: string;
    data?: Record<string, unknown>;
  },
): Promise<{ success: number; failure: number }> {
  const firebaseApp = ensureApp();
  const unique = [...new Set(tokens.filter(Boolean))];
  if (!firebaseApp || !unique.length) return { success: 0, failure: 0 };

  const messaging = getMessaging(firebaseApp);
  let success = 0;
  let failure = 0;
  const data = stringifyData(payload.data || {});

  for (const token of unique) {
    try {
      await messaging.send({
        token,
        notification: { title: payload.title, body: payload.body },
        data,
      });
      success += 1;
    } catch (err) {
      failure += 1;
      logger.debug("[FCM] Token send failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("[FCM] Push sent", { success, failure });
  return { success, failure };
}

export function initFcm(): void {
  ensureApp();
}
