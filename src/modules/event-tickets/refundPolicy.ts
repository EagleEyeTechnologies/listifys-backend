import { parseEventStartsAt } from "./eventDate.js";

/**
 * Organizer-chosen cancellation rules, saved on the event as `extras.event.refundPolicy`
 * and copied onto each booking so later edits don't change what a guest agreed to.
 */
export type RefundPolicy = {
  preset: string;
  allowCancellation: boolean;
  /** Guests can't cancel at all within this many hours of the start. */
  cutoffHours: number;
  /** Refund percent when cancelling at least `hoursBefore` hours ahead. Sorted longest first. */
  tiers: { hoursBefore: number; percent: number }[];
};

const MAX_HOURS = 24 * 60;

function clampInt(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeRefundPolicy(raw: unknown): RefundPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const allowCancellation = r.allowCancellation !== false;
  const cutoffHours = clampInt(r.cutoffHours, 0, MAX_HOURS) ?? 0;
  const seen = new Set<number>();
  const tiers = (Array.isArray(r.tiers) ? r.tiers : [])
    .map((t) => {
      const row = t && typeof t === "object" ? (t as Record<string, unknown>) : {};
      const hoursBefore = clampInt(row.hoursBefore, 0, MAX_HOURS);
      const percent = clampInt(row.percent, 0, 100);
      return hoursBefore == null || percent == null ? null : { hoursBefore, percent };
    })
    .filter((t): t is { hoursBefore: number; percent: number } => {
      if (!t || seen.has(t.hoursBefore)) return false;
      seen.add(t.hoursBefore);
      return true;
    })
    .sort((a, b) => b.hoursBefore - a.hoursBefore);
  return {
    preset: typeof r.preset === "string" ? r.preset.slice(0, 40) : "custom",
    allowCancellation,
    cutoffHours,
    tiers: allowCancellation ? tiers : [],
  };
}

export function refundPolicyFromExtras(extras: unknown): RefundPolicy | null {
  const event =
    extras && typeof extras === "object"
      ? (extras as { event?: Record<string, unknown> }).event
      : undefined;
  return normalizeRefundPolicy(event?.refundPolicy);
}

export type RefundQuote = {
  allowed: boolean;
  percent: number;
  /** Why cancelling is not possible, shown to the guest. */
  reason?: string;
  /** Last moment the guest can cancel, when the policy has a cutoff. */
  cancelBy?: string;
};

export function quoteRefund(
  policy: RefundPolicy,
  startsAt: string | Date | null | undefined,
  now = new Date(),
): RefundQuote {
  const start = parseEventStartsAt(startsAt ?? null);
  const hoursLeft = start ? (start.getTime() - now.getTime()) / 3_600_000 : Infinity;
  const cancelBy =
    start && policy.allowCancellation
      ? new Date(start.getTime() - policy.cutoffHours * 3_600_000).toISOString()
      : undefined;
  if (!policy.allowCancellation) {
    return { allowed: false, percent: 0, reason: "This event does not allow cancellations." };
  }
  if (hoursLeft <= 0) {
    return { allowed: false, percent: 0, reason: "The event has already started.", cancelBy };
  }
  if (hoursLeft < policy.cutoffHours) {
    return {
      allowed: false,
      percent: 0,
      reason: `Cancellations close ${hoursLabel(policy.cutoffHours)} before the event.`,
      cancelBy,
    };
  }
  const tier = policy.tiers.find((t) => hoursLeft >= t.hoursBefore);
  return { allowed: true, percent: tier?.percent ?? 0, cancelBy };
}

export function hoursLabel(hours: number): string {
  if (hours % 24 === 0 && hours >= 24) {
    const days = hours / 24;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
