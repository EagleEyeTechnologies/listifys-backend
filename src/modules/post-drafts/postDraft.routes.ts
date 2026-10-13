import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../utils/AppError.js";
import {
  deletePostDraft,
  draftClientIdSchema,
  listPostDrafts,
  savePostDraft,
  savePostDraftSchema,
} from "./postDraft.service.js";

export const postDraftsRouter = Router();

postDraftsRouter.use(requireAuth);

function clientIdParam(raw: unknown): string {
  const parsed = draftClientIdSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(400, "Invalid draft id", "VALIDATION_ERROR");
  return parsed.data;
}

postDraftsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const data = await listPostDrafts(req.userId!);
    res.json({ success: true, data });
  }),
);

postDraftsRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const clientId = clientIdParam(req.params.id);
    const parsed = savePostDraftSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid draft", "VALIDATION_ERROR");
    }
    const data = await savePostDraft(req.userId!, clientId, parsed.data);
    res.json({ success: true, data });
  }),
);

postDraftsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await deletePostDraft(req.userId!, clientIdParam(req.params.id));
    res.json({ success: true, data: { deleted: true } });
  }),
);
