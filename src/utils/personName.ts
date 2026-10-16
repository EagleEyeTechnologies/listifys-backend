import { z } from "zod";

export const PERSON_NAME_MAX = 40;

export function sanitizePersonName(value: string) {
  return value
    .replace(/[^\p{L}\s.'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PERSON_NAME_MAX);
}

export function personNameError(value: string): string | null {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) return "Enter your full name";
  if (name.length > PERSON_NAME_MAX) return "Name must be 40 characters or fewer";
  if (!/^[\p{L}][\p{L}\s.'-]*$/u.test(name)) {
    return "Use letters only. Numbers are not allowed in a name";
  }
  const letters = name.replace(/[^\p{L}]/gu, "");
  if (letters.length < 2) return "Enter at least 2 letters";
  return null;
}

export const personNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(PERSON_NAME_MAX)
  .superRefine((value, ctx) => {
    const message = personNameError(value);
    if (message) ctx.addIssue({ code: "custom", message });
  });

/** Empty stays empty. A provided name must be a real name. */
export const optionalPersonNameSchema = z
  .string()
  .trim()
  .max(PERSON_NAME_MAX)
  .optional()
  .superRefine((value, ctx) => {
    if (!value) return;
    const message = personNameError(value);
    if (message) ctx.addIssue({ code: "custom", message });
  });
