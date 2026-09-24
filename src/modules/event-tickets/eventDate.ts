/** Shared event date parsing for booking gates. */

export function parseEventStartsAt(raw?: string | null): Date | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
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

export function isEventPastFromExtras(extras: unknown, now = new Date()): boolean {
  const event =
    extras && typeof extras === "object"
      ? (extras as { event?: { startsAt?: string } }).event
      : undefined;
  const d = parseEventStartsAt(event?.startsAt);
  if (!d) return false;
  return d.getTime() < now.getTime();
}
