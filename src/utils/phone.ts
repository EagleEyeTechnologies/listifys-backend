/** Normalize phoneCode + local number for consistent display / storage. */

const COUNTRY_CODES = ["+91", "+1", "+44", "+61", "+971"] as const;

export function stripPhoneDigits(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Validate national number for OTP / profile change.
 * +91: exactly 10 digits, must start with 6–9 (no leading 0).
 * +1: exactly 10 digits.
 * Other codes: 8–15 digits, no leading 0.
 */
export function assertValidNationalPhone(
  phoneCode: string,
  phone: string,
): { phoneCode: string; phone: string } {
  const code = String(phoneCode || "+91").trim() || "+91";
  const raw = String(phone || "").trim();
  const digits = stripPhoneDigits(raw);

  if (!digits) {
    throw new Error("Enter a valid phone number");
  }
  if (raw.startsWith("0") || digits.startsWith("0")) {
    throw new Error(
      code === "+91"
        ? "Enter a 10-digit mobile number without a leading 0"
        : "Remove the leading 0 and enter the national number only",
    );
  }

  if (code === "+91") {
    if (digits.length !== 10 || !/^[6-9]\d{9}$/.test(digits)) {
      throw new Error("Enter a valid 10-digit Indian mobile number");
    }
    return { phoneCode: "+91", phone: digits };
  }

  if (code === "+1") {
    if (digits.length !== 10) {
      throw new Error("Enter a valid 10-digit phone number");
    }
    return { phoneCode: "+1", phone: digits };
  }

  if (digits.length < 8 || digits.length > 15) {
    throw new Error("Enter a valid phone number");
  }
  return { phoneCode: code, phone: digits };
}

/** Parse and validate DOB string (YYYY-MM-DD or DD-MM-YYYY). */
export function assertValidDateOfBirth(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";

  let year = 0;
  let month = 0;
  let day = 0;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dmy = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (dmy) {
    day = Number(dmy[1]);
    month = Number(dmy[2]);
    year = Number(dmy[3]);
  } else {
    throw new Error("Enter a valid date of birth");
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  if (year < 1900 || year > currentYear) {
    throw new Error(`Year must be between 1900 and ${currentYear}`);
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error("Enter a valid date of birth");
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    throw new Error("Enter a valid date of birth");
  }
  if (dt.getTime() > Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) {
    throw new Error("Date of birth cannot be in the future");
  }
  const age =
    currentYear -
    year -
    (now.getMonth() + 1 < month ||
    (now.getMonth() + 1 === month && now.getDate() < day)
      ? 1
      : 0);
  if (age < 13) {
    throw new Error("You must be at least 13 years old");
  }

  return `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
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
export function formatPhoneDisplay(phoneCode?: string | null, phone?: string | null): string {
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
