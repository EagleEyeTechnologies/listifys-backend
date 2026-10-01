export type SocialField = "website" | "instagram" | "linkedin" | "twitter";

const PLATFORM_HOSTS: Record<Exclude<SocialField, "website">, string[]> = {
  instagram: ["instagram.com"],
  linkedin: ["linkedin.com"],
  twitter: ["x.com", "twitter.com"],
};

const FIELD_LABEL: Record<SocialField, string> = {
  website: "Website",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  twitter: "Twitter / X",
};

/** Empty is allowed. Otherwise the value must be an http(s) URL, with the right host for social profiles. */
export function socialLinkError(field: SocialField, raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (/\s/.test(value)) {
    return `Enter a valid ${FIELD_LABEL[field]} URL without spaces`;
  }
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return `Enter a valid ${FIELD_LABEL[field]} URL`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Use an http or https URL";
  }
  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
    return `Enter a valid ${FIELD_LABEL[field]} URL`;
  }
  if (field === "website") return "";
  const allowed = PLATFORM_HOSTS[field];
  const hostOk = allowed.some((item) => host === item || host.endsWith(`.${item}`));
  if (!hostOk) {
    const sample = field === "twitter" ? "x.com/username" : `${allowed[0]}/username`;
    return `Use a link like ${sample}`;
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (!path || path === "/") {
    return `Include your profile path, for example ${field === "twitter" ? "x.com/username" : `${allowed[0]}/username`}`;
  }
  return "";
}
