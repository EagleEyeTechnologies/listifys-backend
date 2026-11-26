import { AppError } from "../../utils/AppError.js";

/** Message for an admin password change, or null when the pair is acceptable. */
export function adminPasswordUpdateMessage(currentPassword: string, newPassword: string) {
  const current = currentPassword.trim();
  const next = newPassword.trim();
  if (!current && !next) return "Current password and new password are required.";
  if (!current) return "Current password is required.";
  if (!next) return "New password is required.";
  if (next.length < 8) return "New password must be at least 8 characters.";
  if (next.length > 128) return "New password must be at most 128 characters.";
  if (current === next) return "New password must be different from the current password.";
  return null;
}

export function assertStrongPassword(password: string) {
  const ok =
    password.length >= 8 &&
    password.length <= 128 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password);
  if (!ok) {
    throw new AppError(
      400,
      "Password must be at least 8 characters and include uppercase, lowercase, a number, and a special character.",
      "WEAK_PASSWORD",
    );
  }
}
