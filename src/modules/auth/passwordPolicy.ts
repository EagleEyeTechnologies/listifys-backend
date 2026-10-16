import { AppError } from "../../utils/AppError.js";

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
