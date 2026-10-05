/** Shared event date parsing for booking gates. */

export function parseEventStartsAt(raw?: string | Date | null): Date | null {
  if (!raw) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  const s = String(raw).trim();
  if (!s) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const local = !hasZone
    ? s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/)
    : null;
  if (local) {
    const d = new Date(
      Number(local[1]),
      Number(local[2]) - 1,
      Number(local[3]),
      Number(local[4] || 0),
      Number(local[5] || 0),
      Number(local[6] || 0),
    );
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

export function isEventPastFromExtras(extras: unknown, now = new Date()): boolean {
  const event =
    extras && typeof extras === "object"
      ? (extras as { event?: { startsAt?: string } }).event
      : undefined;
  const d = parseEventStartsAt(event?.startsAt);
  if (!d) return false;
  return d.getTime() < now.getTime();
}
