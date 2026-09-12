import Redis from "ioredis";
import { Redis as UpstashRedis } from "@upstash/redis";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

let redis: Redis | null = null;
let upstash: UpstashRedis | null = null;
let redisAvailable = false;
type Backend = "ioredis" | "upstash" | "memory";
let backend: Backend = "memory";

const memory = new Map<string, { value: string; expiresAt?: number }>();

function memoryGet(key: string): string | null {
  const row = memory.get(key);
  if (!row) return null;
  if (row.expiresAt && Date.now() > row.expiresAt) {
    memory.delete(key);
    return null;
  }
  return row.value;
}

function memorySet(key: string, value: string, ttlSeconds?: number) {
  memory.set(key, {
    value,
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
  });
}

function memoryDel(key: string) {
  memory.delete(key);
}

function trimEnv(value?: string) {
  return (value || "").trim().replace(/^["']|["']$/g, "");
}

export async function connectRedis(): Promise<void> {
  const restUrl = trimEnv(env.UPSTASH_REDIS_REST_URL);
  const restToken = trimEnv(env.UPSTASH_REDIS_REST_TOKEN);
  const redisUrl = trimEnv(env.REDIS_URL);

  if (restUrl && restToken) {
    try {
      upstash = new UpstashRedis({ url: restUrl, token: restToken });
      await upstash.ping();
      redisAvailable = true;
      backend = "upstash";
      logger.info("Redis connected (Upstash REST)");
      return;
    } catch (err) {
      logger.warn("Upstash Redis ping failed — trying REDIS_URL / memory", {
        err: err instanceof Error ? err.message : String(err),
      });
      upstash = null;
    }
  }

  if (!redisUrl) {
    logger.warn("REDIS_URL / Upstash not set — using in-memory store for OTP/tokens");
    return;
  }

  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });

  try {
    await redis.connect();
    redisAvailable = true;
    backend = "ioredis";
    logger.info("Redis connected");
  } catch (err) {
    logger.warn("Redis connect failed — falling back to in-memory store", {
      err: err instanceof Error ? err.message : String(err),
    });
    redis.disconnect();
    redis = null;
    redisAvailable = false;
    backend = "memory";
  }
}

export function redisReady(): boolean {
  return redisAvailable;
}

export function redisBackend(): Backend {
  return backend;
}

/** TCP ioredis client (BullMQ). Null when only Upstash REST is available. */
export function getRedis(): Redis | null {
  return backend === "ioredis" && redisAvailable ? redis : null;
}

export const kv = {
  async get(key: string): Promise<string | null> {
    if (backend === "upstash" && upstash) {
      const v = await upstash.get<string>(key);
      if (v === null || v === undefined) return null;
      return typeof v === "string" ? v : String(v);
    }
    if (backend === "ioredis" && redis) return redis.get(key);
    return memoryGet(key);
  },
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (backend === "upstash" && upstash) {
      if (ttlSeconds) await upstash.set(key, value, { ex: ttlSeconds });
      else await upstash.set(key, value);
      return;
    }
    if (backend === "ioredis" && redis) {
      if (ttlSeconds) await redis.set(key, value, "EX", ttlSeconds);
      else await redis.set(key, value);
      return;
    }
    memorySet(key, value, ttlSeconds);
  },
  async del(key: string): Promise<void> {
    if (backend === "upstash" && upstash) {
      await upstash.del(key);
      return;
    }
    if (backend === "ioredis" && redis) {
      await redis.del(key);
      return;
    }
    memoryDel(key);
  },
};
