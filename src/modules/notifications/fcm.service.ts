/**
 * FCM push via Firebase Admin (modular SDK).
 */
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { resolveFirebaseServiceAccount } from "./firebaseCredentials.js";
import { sendWebPush } from "./webPush.service.js";

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

    const resolved = resolveFirebaseServiceAccount(env);
    if (!resolved) {
      logger.warn(
        "[FCM] No Firebase credentials — device push disabled. Set FIREBASE_SERVICE_ACCOUNT_JSON (one-line JSON) or FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.",
        { pathConfigured: Boolean(env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim()) },
      );
      return null;
    }

    app = initializeApp({
      credential: cert(resolved.account as Parameters<typeof cert>[0]),
    });
    logger.info("[FCM] Firebase Admin SDK initialized", { source: resolved.source });
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
): Promise<{ success: number; failure: number; invalidTokens: string[] }> {
  const firebaseApp = ensureApp();
  const unique = [...new Set(tokens.filter(Boolean))];
  if (!unique.length) return { success: 0, failure: 0, invalidTokens: [] };

  const messaging = firebaseApp ? getMessaging(firebaseApp) : null;
  let success = 0;
  let failure = 0;
  const invalidTokens: string[] = [];
  const data = stringifyData(payload.data || {});

  for (const token of unique) {
    try {
      if (token.startsWith("{") && token.includes("endpoint")) {
        const result = await sendWebPush(token, {
          title: payload.title,
          body: payload.body,
          href: data.href,
        });
        if (result === "invalid") invalidTokens.push(token);
        else success += 1;
        continue;
      }
      if (token.startsWith("ExponentPushToken")) {
        const res = await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            to: token,
            title: payload.title,
            body: payload.body,
            sound: "default",
            priority: "high",
            channelId: "default",
            data,
          }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          data?: { status?: string; details?: { error?: string } };
        };
        const status = json.data?.status;
        const error = json.data?.details?.error || "";
        if (!res.ok || status === "error") {
          failure += 1;
          if (/DeviceNotRegistered|InvalidCredentials/i.test(error)) invalidTokens.push(token);
        } else {
          success += 1;
        }
        continue;
      }
      if (!messaging) {
        failure += 1;
        continue;
      }
      await messaging.send({
        token,
        notification: { title: payload.title, body: payload.body },
        data,
        android: {
          priority: "high",
          notification: {
            channelId: "default",
            sound: "default",
            priority: "high",
            visibility: "public",
          },
        },
        apns: {
          headers: { "apns-priority": "10" },
          payload: {
            aps: {
              sound: "default",
              alert: { title: payload.title, body: payload.body },
            },
          },
        },
      });
      success += 1;
    } catch (err) {
      failure += 1;
      const message = err instanceof Error ? err.message : String(err);
      if (/registration token|not registered|invalid.*token/i.test(message)) {
        invalidTokens.push(token);
      }
      logger.debug("[FCM] Token send failed", { error: message });
    }
  }

  logger.info("[FCM] Push sent", { success, failure, invalid: invalidTokens.length });
  return { success, failure, invalidTokens };
}

export function initFcm(): void {
  ensureApp();
}
