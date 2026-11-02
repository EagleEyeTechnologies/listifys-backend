import { describe, expect, it } from "vitest";
import { notificationScheduleIssue } from "./notificationSchedule.js";

const now = Date.parse("2026-10-30T12:00:00.000Z");

describe("notificationScheduleIssue", () => {
  it("ignores drafts and immediate sends", () => {
    expect(notificationScheduleIssue("draft", undefined, now)).toBeNull();
    expect(notificationScheduleIssue("sent", undefined, now)).toBeNull();
  });

  it("requires a future instant for scheduled campaigns", () => {
    expect(notificationScheduleIssue("scheduled", undefined, now)).toBe(
      "Choose a date and time to schedule this notification.",
    );
    expect(notificationScheduleIssue("scheduled", "2026-10-30T11:00:00.000Z", now)).toBe(
      "Schedule time must be in the future.",
    );
    expect(notificationScheduleIssue("scheduled", "2026-10-30T12:30:00.000Z", now)).toBeNull();
  });
});
