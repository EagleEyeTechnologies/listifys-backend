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
const appleJwks = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

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

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  const audiences = googleAudiences();
  if (!audiences.length) {
    throw new AppError(503, "Google sign-in is not configured", "SOCIAL_AUTH_UNAVAILABLE");
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
      throw new AppError(401, "Invalid Google ID token payload", "UNAUTHORIZED");
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
    throw new AppError(401, `Google authentication failed: ${message}`, "UNAUTHORIZED");
  }
}

export async function verifyGoogleAccessToken(accessToken: string): Promise<GoogleIdentity> {
  const audiences = googleAudiences();
  if (!audiences.length) {
    throw new AppError(503, "Google sign-in is not configured", "SOCIAL_AUTH_UNAVAILABLE");
  }
  if (!accessToken || accessToken.length < 20) {
    throw new AppError(401, "Invalid Google access token", "UNAUTHORIZED");
  }

  let info: {
    aud?: string;
    azp?: string;
    sub?: string;
    email?: string;
    email_verified?: string | boolean;
    error?: string;
  };
  try {
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
    );
    info = (await res.json()) as typeof info;
    if (!res.ok || info.error) {
      throw new AppError(401, "Google sign-in expired. Please try again.", "UNAUTHORIZED");
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(401, "Google authentication failed", "UNAUTHORIZED");
  }

  const allowed = new Set(audiences);
  const audienceOk = [info.aud, info.azp].some((value) => value && allowed.has(value));
  if (!audienceOk || !info.sub) {
    throw new AppError(401, "Google token was not issued for Listifys", "UNAUTHORIZED");
  }

  let name: string | undefined;
  let picture: string | undefined;
  let email = info.email ? String(info.email).toLowerCase() : "";
  let emailVerified = info.email_verified === true || info.email_verified === "true";
  try {
    const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (userRes.ok) {
      const profile = (await userRes.json()) as {
        email?: string;
        email_verified?: boolean;
        name?: string;
        picture?: string;
        sub?: string;
      };
      if (profile.email) email = profile.email.toLowerCase();
      if (profile.email_verified) emailVerified = true;
      name = profile.name;
      picture = profile.picture;
    }
  } catch {
    /* tokeninfo email is enough to sign in */
  }

  if (!email) {
    throw new AppError(401, "Google account has no email address", "UNAUTHORIZED");
  }

  return {
    googleId: info.sub,
    email,
    emailVerified,
    name,
    picture,
  };
}

export async function verifyAppleIdentityToken(identityToken: string): Promise<AppleIdentity> {
  const audiences = appleAudiences();
  if (!audiences.length) {
    throw new AppError(503, "Apple sign-in is not configured", "SOCIAL_AUTH_UNAVAILABLE");
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
      emailVerified: payload.email_verified === true || payload.email_verified === "true",
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : "Verification failed";
    throw new AppError(401, `Apple authentication failed: ${message}`, "UNAUTHORIZED");
  }
}
