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

export async function listJobAlerts(userId: string) {
  const docs = await JobAlert.find({ user: userId }).sort({ createdAt: -1 }).limit(50);
  return docs.map(serialize);
}

export async function createJobAlert(userId: string, input: z.infer<typeof createJobAlertSchema>) {
  const existing = input.listingId
    ? await JobAlert.findOne({ user: userId, listingId: input.listingId })
    : null;
  const doc = existing
    ? await JobAlert.findByIdAndUpdate(
        existing._id,
        {
          keyword: input.keyword,
          location: input.location,
          jobType: input.jobType,
          experience: input.experience,
        },
        { new: true },
      )
    : await JobAlert.create({
        user: userId,
        listingId: input.listingId,
        keyword: input.keyword,
        location: input.location,
        jobType: input.jobType,
        experience: input.experience,
      });
  if (!doc) throw new Error("Could not save job alert");
  if (!existing) {
    const where = input.location ? ` in ${input.location}` : "";
    await createNotification({
      userId,
      type: "listing",
      title: "Job alert created",
      body: `Watching for “${input.keyword}”${where}.`,
      href: "/jobs",
    });
  }
  return serialize(doc);
}
