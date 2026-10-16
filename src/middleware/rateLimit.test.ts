import { describe, expect, it } from "vitest";
import { authRateSubject } from "./rateLimit.js";

describe("authRateSubject", () => {
  it("keys each email and phone on its own, not the shared network", () => {
    expect(authRateSubject({ email: " A@Listifys.com " })).toBe("email:a@listifys.com");
    expect(authRateSubject({ phone: "98765 43210", phoneCode: "+91" })).toBe("phone:91:9876543210");
    expect(authRateSubject({ email: "a@b.com" })).not.toBe(authRateSubject({ email: "c@d.com" }));
    expect(authRateSubject({ phone: "9000000001", phoneCode: "+91" })).not.toBe(
      authRateSubject({ phone: "9000000002", phoneCode: "+91" }),
    );
  });

  it("returns null when the request has no account to isolate", () => {
    expect(authRateSubject({})).toBeNull();
    expect(authRateSubject(null)).toBeNull();
  });

  it("prefers the signed-in user over the body", () => {
    expect(authRateSubject({ email: "a@b.com" }, "user-1")).toBe("user:user-1");
  });
});
