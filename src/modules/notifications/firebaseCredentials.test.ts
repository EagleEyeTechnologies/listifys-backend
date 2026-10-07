import { describe, expect, it } from "vitest";
import { resolveFirebaseServiceAccount } from "./firebaseCredentials.js";

const account = { project_id: "listifys", client_email: "a@b.iam", private_key: "k" };
const noFiles = () => false;

describe("resolveFirebaseServiceAccount", () => {
  it("falls back to inline JSON when the configured file is missing", () => {
    const resolved = resolveFirebaseServiceAccount(
      {
        FIREBASE_SERVICE_ACCOUNT_PATH: "config/firebase-service-account.json",
        FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(account),
      },
      "/app",
      noFiles,
    );
    expect(resolved?.source).toBe("json");
    expect(resolved?.account.project_id).toBe("listifys");
  });

  it("strips quotes Docker env files leave around values", () => {
    const resolved = resolveFirebaseServiceAccount(
      { FIREBASE_SERVICE_ACCOUNT_JSON: `'${JSON.stringify(account)}'` },
      "/app",
      noFiles,
    );
    expect(resolved?.source).toBe("json");
  });

  it("uses the split fields and restores newlines in the key", () => {
    const resolved = resolveFirebaseServiceAccount(
      {
        FIREBASE_SERVICE_ACCOUNT_PATH: "missing.json",
        FIREBASE_PROJECT_ID: "listifys",
        FIREBASE_CLIENT_EMAIL: "a@b.iam",
        FIREBASE_PRIVATE_KEY: '"line1\\nline2"',
      },
      "/app",
      noFiles,
    );
    expect(resolved?.source).toBe("fields");
    expect(resolved?.account.private_key).toBe("line1\nline2");
  });

  it("reads the file when it exists", () => {
    const resolved = resolveFirebaseServiceAccount(
      { FIREBASE_SERVICE_ACCOUNT_PATH: "/secrets/sa.json" },
      "/app",
      (p) => p === "/secrets/sa.json",
      () => JSON.stringify(account),
    );
    expect(resolved?.source).toBe("file");
  });

  it("returns null with nothing usable", () => {
    expect(
      resolveFirebaseServiceAccount(
        { FIREBASE_SERVICE_ACCOUNT_PATH: "missing.json" },
        "/app",
        noFiles,
      ),
    ).toBeNull();
  });
});
