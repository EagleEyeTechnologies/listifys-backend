import { describe, expect, it } from "vitest";
import { isMongoObjectId, listingSlugFrom, slugify } from "./slug.js";

describe("slugify", () => {
  it("normalizes titles into URL-safe slugs", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
    expect(slugify("Café & Tea")).toBe("cafe-and-tea");
  });

  it("uses fallback for empty input", () => {
    expect(slugify("   ")).toBe("item");
  });
});

describe("listingSlugFrom", () => {
  it("appends a short id suffix", () => {
    expect(listingSlugFrom("Red Bike", "507f1f77bcf86cd799439011")).toBe("red-bike-439011");
  });
});

describe("isMongoObjectId", () => {
  it("validates 24-char hex ids", () => {
    expect(isMongoObjectId("507f1f77bcf86cd799439011")).toBe(true);
    expect(isMongoObjectId("not-an-id")).toBe(false);
  });
});
