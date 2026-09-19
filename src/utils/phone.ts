/** Normalize phoneCode + local number for consistent display / storage. */

const COUNTRY_CODES = ["+91", "+1", "+44", "+61", "+971"] as const;

export function stripPhoneDigits(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Prefer storing national digits in `phone` and dial code in `phoneCode`.
 * Handles legacy values where phone already includes +91 / 91.
 */
export function normalizePhoneParts(
  phoneCode?: string | null,
  phone?: string | null,
): { phoneCode: string; phone: string } {
  const rawCode = String(phoneCode || "").trim();
  const rawPhone = String(phone || "").trim();
  if (!rawCode && !rawPhone) return { phoneCode: "", phone: "" };

  let digits = stripPhoneDigits(rawPhone || rawCode);
  let code = rawCode.startsWith("+") ? rawCode : rawCode ? `+${stripPhoneDigits(rawCode)}` : "";

  // Full E.164 jammed into phone with empty/wrong code
  if (digits.startsWith("91") && digits.length === 12) {
    code = "+91";
    digits = digits.slice(2);
  } else if (digits.startsWith("1") && digits.length === 11 && (!code || code === "+1")) {
    code = "+1";
    digits = digits.slice(1);
  }

  // phone field already had +91…
  if (rawPhone.startsWith("+91") && digits.length >= 12) {
    code = "+91";
    digits = digits.slice(-10);
  } else if (rawPhone.startsWith("+1") && digits.length >= 11) {
    code = "+1";
    digits = digits.slice(-10);
  }

  if (!code) {
    for (const c of COUNTRY_CODES) {
      const cd = stripPhoneDigits(c);
      if (digits.startsWith(cd) && digits.length > cd.length + 6) {
        code = c;
        digits = digits.slice(cd.length);
        break;
      }
    }
  }

  // Drop duplicated country code from national number
  if (code === "+91" && digits.length === 12 && digits.startsWith("91")) {
    digits = digits.slice(2);
  }
  if (code === "+91" && digits.length > 10) {
    digits = digits.slice(-10);
  }

  if (!code) code = "+91";

  return { phoneCode: code, phone: digits };
}

/** Display as `+91 9347190965` (space after dial code). */
export function formatPhoneDisplay(
  phoneCode?: string | null,
  phone?: string | null,
): string {
  const parts = normalizePhoneParts(phoneCode, phone);
  if (!parts.phone && !parts.phoneCode) return "—";
  if (!parts.phone) return parts.phoneCode || "—";
  return `${parts.phoneCode} ${parts.phone}`.trim();
}

/** Legacy / placeholder emails created for phone-only accounts — not real inboxes. */
export function isSyntheticEmail(email?: string | null): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  return (
    /@users\.listifys\.app$/i.test(e) ||
    /@listifys\.test$/i.test(e) ||
    /^phone\.\d+@/i.test(e) ||
    /^beta\+\d+@/i.test(e)
  );
}

/** Apple "Hide My Email" relay addresses — treat as private, prompt for a real inbox. */
export function isApplePrivateRelayEmail(email?: string | null): boolean {
  if (!email) return false;
  return /@privaterelay\.appleid\.com$/i.test(email.trim());
}

export function needsPublicEmail(email?: string | null): boolean {
  if (!email?.trim()) return true;
  return isSyntheticEmail(email) || isApplePrivateRelayEmail(email);
}

export function displayEmail(email?: string | null): string {
  if (!email?.trim() || isSyntheticEmail(email)) return "—";
  return email.trim();
}
