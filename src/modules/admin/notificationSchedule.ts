/** Message when a campaign cannot be scheduled, or null when the instant is in the future. */
export function notificationScheduleIssue(
  status: string,
  scheduledAt?: string | null,
  now = Date.now(),
) {
  if (status !== "scheduled") return null;
  if (!scheduledAt) return "Choose a date and time to schedule this notification.";
  const when = new Date(scheduledAt);
  if (Number.isNaN(when.getTime()) || when.getTime() <= now) {
    return "Schedule time must be in the future.";
  }
  return null;
}
