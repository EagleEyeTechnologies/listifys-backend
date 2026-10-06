/** Shared event date parsing for booking gates. */

/** Used when the duration can't be read, e.g. "Evening". */
export const DEFAULT_EVENT_MINUTES = 180;

/** Offsets for events saved before `utcOffsetMinutes` existed (single-zone markets only). */
const MARKET_UTC_OFFSET: Record<string, number> = { IN: 330 };

/**
 * `utcOffsetMinutes` is the organizer's offset for zone-less values like "2026-10-06T09:54".
 * Without it they are read in the server's timezone.
 */
export function parseEventStartsAt(
  raw?: string | Date | null,
  utcOffsetMinutes?: number,
): Date | null {
  if (!raw) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  const s = String(raw).trim();
  if (!s) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const local = !hasZone
    ? s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/)
    : null;
  if (local) {
    const parts = [
      Number(local[1]),
      Number(local[2]) - 1,
      Number(local[3]),
      Number(local[4] || 0),
      Number(local[5] || 0),
      Number(local[6] || 0),
    ] as const;
    if (typeof utcOffsetMinutes === "number" && Number.isFinite(utcOffsetMinutes)) {
      const utc = Date.UTC(...parts);
      if (Number.isFinite(utc)) return new Date(utc - utcOffsetMinutes * 60_000);
    }
    const d = new Date(...parts);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const iso = Date.parse(s);
  if (Number.isFinite(iso) && !Number.isNaN(iso)) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const cleaned = s.replace(/·/g, " ").replace(/\s+/g, " ").trim();
  const fallback = Date.parse(cleaned);
  if (Number.isFinite(fallback) && !Number.isNaN(fallback)) {
    const d = new Date(fallback);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/** Minutes in an organizer-typed duration: "1 hour", "2h 30m", "90 mins", "1:30", "2 days". */
export function parseDurationMinutes(raw: unknown): number | null {
  const s = String(raw ?? "")
    .toLowerCase()
    .trim();
  if (!s) return null;
  const clock = s.match(/^(\d{1,2}):(\d{2})$/);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]) || null;
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?)\b/g)) {
    const n = parseFloat(m[1]!);
    const unit = m[2]!;
    total += unit.startsWith("d") ? n * 1440 : unit.startsWith("h") ? n * 60 : n;
    matched = true;
  }
  if (!matched) {
    if (/full[\s-]*day|all[\s-]*day/.test(s)) return 1440;
    if (/half[\s-]*day/.test(s)) return 240;
    const bare = s.match(/^(\d+(?:\.\d+)?)$/);
    if (bare) total = parseFloat(bare[1]!) * 60;
  }
  return total > 0 ? Math.min(Math.round(total), 30 * 1440) : null;
}

type EventFields = { startsAt?: unknown; duration?: unknown; utcOffsetMinutes?: unknown };

function eventOf(extras: unknown): EventFields | undefined {
  return extras && typeof extras === "object"
    ? (extras as { event?: EventFields }).event
    : undefined;
}

function offsetFor(event: EventFields | undefined, countryCode?: string | null) {
  const n = Number(event?.utcOffsetMinutes);
  if (event?.utcOffsetMinutes != null && Number.isFinite(n) && Math.abs(n) <= 14 * 60) return n;
  return MARKET_UTC_OFFSET[String(countryCode || "").toUpperCase()];
}

/** Event start as an absolute time, using the organizer's timezone. */
export function eventStartFromExtras(extras: unknown, countryCode?: string | null): Date | null {
  const event = eventOf(extras);
  const raw = event?.startsAt;
  return parseEventStartsAt(
    typeof raw === "string" || raw instanceof Date ? raw : null,
    offsetFor(event, countryCode),
  );
}

/** Start plus duration. */
export function eventEndFromExtras(extras: unknown, countryCode?: string | null): Date | null {
  const start = eventStartFromExtras(extras, countryCode);
  if (!start) return null;
  const minutes = parseDurationMinutes(eventOf(extras)?.duration) ?? DEFAULT_EVENT_MINUTES;
  return new Date(start.getTime() + minutes * 60_000);
}

/** True once the event has finished (start + duration). */
export function isEventPastFromExtras(
  extras: unknown,
  countryCode?: string | null,
  now = new Date(),
): boolean {
  const end = eventEndFromExtras(extras, countryCode);
  return end ? end.getTime() <= now.getTime() : false;
}
