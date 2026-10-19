import { z } from "zod";
import { JobAlert } from "./jobAlert.model.js";
import { createNotification } from "../notifications/notification.service.js";

export const createJobAlertSchema = z.object({
  keyword: z.string().trim().min(1).max(120),
  location: z.string().trim().max(120).optional().default(""),
  jobType: z.string().trim().max(80).optional().default(""),
  experience: z.string().trim().max(80).optional().default(""),
  listingId: z.string().trim().max(64).optional().default(""),
});

function jobAlertHref(keyword: string, location?: string) {
  const params = new URLSearchParams();
  const q = keyword.trim();
  if (q) params.set("q", q);
  const city = (location || "").trim();
  if (city) params.set("city", city);
  const qs = params.toString();
  return qs ? `/jobs?${qs}` : "/jobs";
}

function norm(value: string | undefined | null) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function serialize(doc: InstanceType<typeof JobAlert>) {
  return {
    id: doc._id.toString(),
    listingId: doc.listingId || "",
    keyword: doc.keyword,
    location: doc.location || "",
    jobType: doc.jobType || "",
    experience: doc.experience || "",
  };
}

/** Same search criteria (case/whitespace-insensitive). */
function sameCriteria(
  a: { keyword?: string; location?: string; jobType?: string; experience?: string },
  b: { keyword?: string; location?: string; jobType?: string; experience?: string },
) {
  return (
    norm(a.keyword) === norm(b.keyword) &&
    norm(a.location) === norm(b.location) &&
    norm(a.jobType) === norm(b.jobType) &&
    norm(a.experience) === norm(b.experience)
  );
}

export async function listJobAlerts(userId: string) {
  const docs = await JobAlert.find({ user: userId }).sort({ createdAt: -1 }).limit(50);
  return docs.map(serialize);
}

export async function createJobAlert(userId: string, input: z.infer<typeof createJobAlertSchema>) {
  const listingId = (input.listingId || "").trim();
  const existingByListing = listingId ? await JobAlert.findOne({ user: userId, listingId }) : null;

  let existing = existingByListing;
  if (!existing) {
    const recent = await JobAlert.find({ user: userId }).sort({ createdAt: -1 }).limit(50);
    existing = recent.find((row) => sameCriteria(row, input)) || null;
  }

  if (existing) {
    const doc = await JobAlert.findByIdAndUpdate(
      existing._id,
      {
        keyword: input.keyword,
        location: input.location,
        jobType: input.jobType,
        experience: input.experience,
        ...(listingId ? { listingId } : {}),
      },
      { new: true },
    );
    if (!doc) throw new Error("Could not save job alert");
    return { alert: serialize(doc), created: false };
  }

  const doc = await JobAlert.create({
    user: userId,
    listingId,
    keyword: input.keyword,
    location: input.location,
    jobType: input.jobType,
    experience: input.experience,
  });
  const where = input.location ? ` in ${input.location}` : "";
  await createNotification({
    userId,
    type: "listing",
    title: "Job alert created",
    body: `Watching for “${input.keyword}”${where}.`,
    href: jobAlertHref(input.keyword, input.location),
  });
  return { alert: serialize(doc), created: true };
}
