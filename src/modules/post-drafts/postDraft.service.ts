import { z } from "zod";
import { PostDraft } from "./postDraft.model.js";

export const MAX_POST_DRAFTS = 20;

export const draftClientIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\w-]+$/);

export const savePostDraftSchema = z.object({
  source: z.enum(["web", "mobile"]),
  step: z.number().int().min(0).max(20).optional().default(0),
  form: z.record(z.string(), z.unknown()),
  savedAt: z.string().datetime().optional(),
});

type DraftDoc = InstanceType<typeof PostDraft>;

function serialize(doc: DraftDoc) {
  return {
    id: doc.clientId,
    source: doc.source,
    step: doc.step ?? 0,
    form: (doc.form ?? {}) as Record<string, unknown>,
    savedAt: (doc.savedAt ?? doc.updatedAt ?? new Date()).toISOString(),
  };
}

export async function listPostDrafts(userId: string) {
  const docs = await PostDraft.find({ user: userId }).sort({ savedAt: -1 }).limit(MAX_POST_DRAFTS);
  return docs.map(serialize);
}

export async function savePostDraft(
  userId: string,
  clientId: string,
  input: z.infer<typeof savePostDraftSchema>,
) {
  const savedAt = input.savedAt ? new Date(input.savedAt) : new Date();
  const existing = await PostDraft.findOne({ user: userId, clientId });
  // A slow request from another device must not overwrite a newer save.
  if (existing?.savedAt && existing.savedAt.getTime() > savedAt.getTime()) {
    return serialize(existing);
  }
  const doc = await PostDraft.findOneAndUpdate(
    { user: userId, clientId },
    { $set: { source: input.source, step: input.step, form: input.form, savedAt } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  if (!doc) throw new Error("Could not save draft");

  const stale = await PostDraft.find({ user: userId })
    .sort({ savedAt: -1 })
    .skip(MAX_POST_DRAFTS)
    .select("_id");
  if (stale.length) await PostDraft.deleteMany({ _id: { $in: stale.map((d) => d._id) } });

  return serialize(doc);
}

export async function deletePostDraft(userId: string, clientId: string) {
  await PostDraft.deleteOne({ user: userId, clientId });
}
