import { describe, expect, it } from "vitest";
import { adminPasswordUpdateMessage } from "./passwordPolicy.js";

describe("adminPasswordUpdateMessage", () => {
  it("requires both fields when they are empty", () => {
    expect(adminPasswordUpdateMessage("", "")).toBe(
      "Current password and new password are required.",
    );
    expect(adminPasswordUpdateMessage("   ", "  ")).toBe(
      "Current password and new password are required.",
    );
  });

  it("names the missing field", () => {
    expect(adminPasswordUpdateMessage("", "new-password-1")).toBe("Current password is required.");
    expect(adminPasswordUpdateMessage("current-password", "")).toBe("New password is required.");
  });

  it("rejects a new password that matches the current password", () => {
    expect(adminPasswordUpdateMessage("Same-password1", "Same-password1")).toBe(
      "New password must be different from the current password.",
    );
  });

  it("accepts a different password of at least 8 characters", () => {
    expect(adminPasswordUpdateMessage("Old-password1", "New-password1")).toBeNull();
  });
});
