import { OAuth2Client } from "google-auth-library";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";

function splitCsv(value?: string) {
  return String(value || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function googleAudiences(): string[] {
  return [
    ...new Set(
      [
        env.GOOGLE_CLIENT_ID,
        env.GOOGLE_MOBILE_WEB_CLIENT_ID,
        env.GOOGLE_ANDROID_CLIENT_ID,
        env.GOOGLE_IOS_CLIENT_ID,
        ...splitCsv(env.GOOGLE_CLIENT_IDS),
      ].filter(Boolean) as string[],
    ),
  ];
}

export function appleAudiences(): string[] {
  return [
    ...new Set(
      [
        env.APPLE_CLIENT_ID,
        env.APPLE_BUNDLE_ID,
        "com.listifys.app",
        ...splitCsv(env.APPLE_CLIENT_IDS),
      ].filter(Boolean) as string[],
    ),
  ];
}

const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID || undefined);
const appleJwks = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys"),
);

export type GoogleIdentity = {
  googleId: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
};

export type AppleIdentity = {
  appleId: string;
  email?: string;
  emailVerified: boolean;
};

export async function verifyGoogleIdToken(
  idToken: string,
): Promise<GoogleIdentity> {
  const audiences = googleAudiences();
  if (!audiences.length) {
    throw new AppError(
      503,
      "Google sign-in is not configured",
      "SOCIAL_AUTH_UNAVAILABLE",
    );
  }
  if (!idToken || idToken.length < 100) {
    throw new AppError(401, "Invalid Google ID token", "UNAUTHORIZED");
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: audiences,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      throw new AppError(
        401,
        "Invalid Google ID token payload",
        "UNAUTHORIZED",
      );
    }
    return {
      googleId: payload.sub,
      email: String(payload.email).toLowerCase(),
      emailVerified: Boolean(payload.email_verified),
      name: payload.name,
      picture: payload.picture,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : "Verification failed";
    throw new AppError(
      401,
      `Google authentication failed: ${message}`,
      "UNAUTHORIZED",
    );
  }
}

export async function verifyAppleIdentityToken(
  identityToken: string,
): Promise<AppleIdentity> {
  const audiences = appleAudiences();
  if (!audiences.length) {
    throw new AppError(
      503,
      "Apple sign-in is not configured",
      "SOCIAL_AUTH_UNAVAILABLE",
    );
  }
  if (!identityToken) {
    throw new AppError(401, "Apple identity token is required", "UNAUTHORIZED");
  }

  try {
    const { payload } = await jwtVerify(identityToken, appleJwks, {
      issuer: "https://appleid.apple.com",
      audience: audiences,
    });
    if (!payload.sub) {
      throw new AppError(401, "Invalid Apple token", "UNAUTHORIZED");
    }
    return {
      appleId: String(payload.sub),
      email: payload.email ? String(payload.email).toLowerCase() : undefined,
      emailVerified:
        payload.email_verified === true || payload.email_verified === "true",
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : "Verification failed";
    throw new AppError(
      401,
      `Apple authentication failed: ${message}`,
      "UNAUTHORIZED",
    );
  }
}
