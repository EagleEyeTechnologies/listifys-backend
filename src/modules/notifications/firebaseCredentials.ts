import fs from "fs";
import path from "path";

export type FirebaseCredentialEnv = {
  FIREBASE_SERVICE_ACCOUNT_JSON?: string;
  FIREBASE_SERVICE_ACCOUNT_PATH?: string;
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
};

export type ResolvedServiceAccount = {
  account: Record<string, unknown>;
  source: "file" | "json" | "fields";
};

/** Docker `--env-file` keeps quotes literally, so `KEY='{...}'` arrives with them. */
function unquote(raw?: string) {
  const s = (raw || "").trim();
  if (s.length >= 2 && (s[0] === "'" || s[0] === '"') && s[s.length - 1] === s[0]) {
    return s.slice(1, -1).trim();
  }
  return s;
}

function fileCandidates(raw: string, cwd: string) {
  return [
    path.isAbsolute(raw) ? raw : null,
    path.join(cwd, raw),
    path.join(cwd, "..", "..", "old-code", "server", raw),
    path.join(cwd, "..", "..", "old-code", "server", "config", "firebase-service-account.json"),
  ].filter(Boolean) as string[];
}

/**
 * Tries a service-account file, then inline JSON, then the split fields. A configured path that
 * doesn't exist (the file is gitignored, so it never reaches the Docker image) falls through
 * instead of disabling push.
 */
export function resolveFirebaseServiceAccount(
  env: FirebaseCredentialEnv,
  cwd = process.cwd(),
  exists: (p: string) => boolean = fs.existsSync,
  read: (p: string) => string = (p) => fs.readFileSync(p, "utf8"),
): ResolvedServiceAccount | null {
  const json = unquote(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const filePath =
    unquote(env.FIREBASE_SERVICE_ACCOUNT_PATH) || (json && !json.startsWith("{") ? json : "");

  if (filePath) {
    const found = fileCandidates(filePath, cwd).find((p) => exists(p));
    if (found)
      return { account: JSON.parse(read(found)) as Record<string, unknown>, source: "file" };
  }

  if (json.startsWith("{")) {
    return { account: JSON.parse(json) as Record<string, unknown>, source: "json" };
  }

  const projectId = unquote(env.FIREBASE_PROJECT_ID);
  const clientEmail = unquote(env.FIREBASE_CLIENT_EMAIL);
  const privateKey = unquote(env.FIREBASE_PRIVATE_KEY);
  if (projectId && clientEmail && privateKey) {
    return {
      account: {
        project_id: projectId,
        client_email: clientEmail,
        private_key: privateKey.replace(/\\n/g, "\n"),
      },
      source: "fields",
    };
  }

  return null;
}
