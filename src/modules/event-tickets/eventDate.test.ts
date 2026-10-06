import { describe, expect, it } from "vitest";
import { eventEndFromExtras, isEventPastFromExtras, parseDurationMinutes } from "./eventDate.js";

describe("parseDurationMinutes", () => {
  it("reads common organizer formats", () => {
    expect(parseDurationMinutes("1 hour")).toBe(60);
    expect(parseDurationMinutes("3 hrs")).toBe(180);
    expect(parseDurationMinutes("2h 30m")).toBe(150);
    expect(parseDurationMinutes("90 mins")).toBe(90);
    expect(parseDurationMinutes("1.5 hours")).toBe(90);
    expect(parseDurationMinutes("1:30")).toBe(90);
    expect(parseDurationMinutes("2 days")).toBe(2880);
    expect(parseDurationMinutes("Full day")).toBe(1440);
    expect(parseDurationMinutes("2")).toBe(120);
  });

  it("returns null when it can't tell", () => {
    expect(parseDurationMinutes("")).toBeNull();
    expect(parseDurationMinutes("Evening")).toBeNull();
    expect(parseDurationMinutes("2 months")).toBeNull();
  });
});

describe("event end time", () => {
  const extras = {
    event: { startsAt: "2026-10-06T09:54", duration: "1 hour", utcOffsetMinutes: 330 },
  };

  it("ends at start plus duration in the organizer's timezone", () => {
    expect(eventEndFromExtras(extras)?.toISOString()).toBe("2026-10-06T05:24:00.000Z");
  });

  it("is still running before the end, and over after it", () => {
    expect(isEventPastFromExtras(extras, "IN", new Date("2026-10-06T05:00:00Z"))).toBe(false);
    expect(isEventPastFromExtras(extras, "IN", new Date("2026-10-06T05:24:00Z"))).toBe(true);
  });

  it("falls back to India time for older Indian events without an offset", () => {
    const legacy = { event: { startsAt: "2026-10-06T09:54", duration: "1 hour" } };
    expect(eventEndFromExtras(legacy, "IN")?.toISOString()).toBe("2026-10-06T05:24:00.000Z");
  });
});
