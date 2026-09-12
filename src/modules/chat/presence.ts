import { kv } from "../../redis/client.js";

/** userId → set of socket ids (multi-tab) */
const onlineUsers = new Map<string, Set<string>>();
const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastSeenMap = new Map<string, string>();

const OFFLINE_GRACE_MS = 5000;
const PRESENCE_KEY = (userId: string) => `socket:presence:${userId}`;

export function isUserOnline(userId: string): boolean {
  const set = onlineUsers.get(userId);
  return Boolean(set && set.size > 0);
}

export function listOnlineUserIds(): string[] {
  return Array.from(onlineUsers.keys()).filter((id) => isUserOnline(id));
}

export function getLastSeen(userId: string): string | null {
  return lastSeenMap.get(userId) || null;
}

async function markOnlineRedis(userId: string) {
  try {
    await kv.set(PRESENCE_KEY(userId), "1");
  } catch {
    /* ignore */
  }
}

async function markOfflineRedis(userId: string) {
  try {
    await kv.del(PRESENCE_KEY(userId));
  } catch {
    /* ignore */
  }
}

export async function isUserOnlineRedis(userId: string): Promise<boolean | null> {
  try {
    const v = await kv.get(PRESENCE_KEY(userId));
    if (v === null) return false;
    return true;
  } catch {
    return null;
  }
}

export type PresenceHandlers = {
  onOnline: (userId: string) => void;
  onOffline: (userId: string, lastSeen: string) => void;
};

/**
 * Track a socket as online. Returns whether this was the user's first socket.
 */
export function trackSocketOnline(
  userId: string,
  socketId: string,
  handlers: PresenceHandlers,
): boolean {
  const existingTimer = offlineTimers.get(userId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    offlineTimers.delete(userId);
  }

  let set = onlineUsers.get(userId);
  const wasOffline = !set || set.size === 0;
  if (!set) {
    set = new Set();
    onlineUsers.set(userId, set);
  }
  set.add(socketId);
  void markOnlineRedis(userId);

  if (wasOffline) {
    handlers.onOnline(userId);
  }
  return wasOffline;
}

/**
 * Remove a socket. If last socket, wait grace period then mark offline.
 */
export function trackSocketOffline(
  userId: string,
  socketId: string,
  handlers: PresenceHandlers,
) {
  const set = onlineUsers.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size > 0) return;

  const lastSeen = new Date().toISOString();
  lastSeenMap.set(userId, lastSeen);

  const existing = offlineTimers.get(userId);
  if (existing) clearTimeout(existing);

  offlineTimers.set(
    userId,
    setTimeout(() => {
      offlineTimers.delete(userId);
      const current = onlineUsers.get(userId);
      if (current && current.size > 0) return;
      onlineUsers.delete(userId);
      void markOfflineRedis(userId);
      handlers.onOffline(userId, lastSeen);
    }, OFFLINE_GRACE_MS),
  );
}

export async function presenceSnapshot(userId: string) {
  let online = isUserOnline(userId);
  if (!online) {
    const redisOnline = await isUserOnlineRedis(userId);
    if (redisOnline === true) online = true;
  }
  return {
    userId,
    isOnline: online,
    lastSeen: getLastSeen(userId),
  };
}
