import { describe, expect, it } from "vitest";
import { AppError } from "./AppError.js";

describe("AppError", () => {
  it("stores status, code, and details", () => {
    const err = new AppError(400, "Bad request", "VALIDATION", { field: "email" });
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toBe("Bad request");
    expect(err.details).toEqual({ field: "email" });
  });
});
