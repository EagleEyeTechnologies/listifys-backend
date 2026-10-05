import fs from "fs";
import path from "path";
import webpush from "web-push";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

type VapidKeys = { publicKey: string; privateKey: string };

let keys: VapidKeys | null = null;

function keyFile() {
  return path.join(process.cwd(), "data", "web-push-vapid.json");
}

export function getVapidPublicKey(): string {
  return loadKeys().publicKey;
}

function loadKeys(): VapidKeys {
  if (keys) return keys;
  const fromEnv =
    env.VAPID_PUBLIC_KEY?.trim() && env.VAPID_PRIVATE_KEY?.trim()
      ? { publicKey: env.VAPID_PUBLIC_KEY.trim(), privateKey: env.VAPID_PRIVATE_KEY.trim() }
      : null;
  if (fromEnv) {
    keys = fromEnv;
  } else if (fs.existsSync(keyFile())) {
    keys = JSON.parse(fs.readFileSync(keyFile(), "utf8")) as VapidKeys;
  } else {
    const generated = webpush.generateVAPIDKeys();
    keys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
    fs.writeFileSync(keyFile(), JSON.stringify(keys));
    logger.info("[WebPush] Generated VAPID keys");
  }
  webpush.setVapidDetails(
    env.VAPID_SUBJECT?.trim() || "mailto:support@listifys.com",
    keys.publicKey,
    keys.privateKey,
  );
  return keys;
}

export async function sendWebPush(
  subscriptionJson: string,
  payload: { title: string; body: string; href?: string },
): Promise<"ok" | "invalid"> {
  loadKeys();
  let subscription: webpush.PushSubscription;
  try {
    subscription = JSON.parse(subscriptionJson) as webpush.PushSubscription;
  } catch {
    return "invalid";
  }
  if (!subscription?.endpoint) return "invalid";
  try {
    await webpush.sendNotification(
      subscription,
      JSON.stringify({
        title: payload.title,
        body: payload.body,
        href: payload.href || "/",
      }),
    );
    return "ok";
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) return "invalid";
    logger.debug("[WebPush] Send failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "ok";
  }
}
