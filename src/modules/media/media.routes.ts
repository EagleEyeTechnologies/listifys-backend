import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import express, { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { env } from "../../config/env.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../utils/AppError.js";
import { s3Configured } from "./s3.js";
import { absolutizeMediaUrl } from "../../utils/mediaUrl.js";

export const mediaRouter = Router();
export const legacyImagesRouter = Router();

/** Old backend served photos at /api/images/:key — redirect to public S3. */
legacyImagesRouter.use((req, res) => {
  const key = String(req.path || "").replace(/^\/+/, "");
  const dest = absolutizeMediaUrl(key);
  if (!key || !/^https?:\/\//i.test(dest)) {
    res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "Image not found" },
    });
    return;
  }
  res.redirect(302, dest);
});

const presignSchema = z.object({
  contentType: z.string().min(3).max(100),
  ext: z.string().min(1).max(10).optional(),
  folder: z.enum(["listings", "profiles"]).optional(),
});

export { s3Configured };

function s3Client() {
  return new S3Client({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}

function publicUrlForKey(key: string, uploadUrl?: string) {
  if (env.AWS_S3_BUCKET_URL) {
    return `${env.AWS_S3_BUCKET_URL.replace(/\/$/, "")}/${key}`;
  }
  if (uploadUrl) return uploadUrl.split("?")[0];
  return `https://${env.AWS_S3_BUCKET_NAME}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
}

function normalizeExt(raw: string | undefined, contentType: string) {
  const fromType = contentType.split("/")[1]?.split(";")[0]?.trim();
  const ext = (raw || fromType || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!ext || ext.length > 5) return "jpg";
  if (ext === "jpeg") return "jpg";
  return ext;
}

mediaRouter.post(
  "/presign",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = presignSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }

    const ext = normalizeExt(parsed.data.ext, parsed.data.contentType);
    const folder = parsed.data.folder || "listings";
    const key = `${folder}/${req.userId}/${randomUUID()}.${ext}`;

    if (!s3Configured()) {
      if (env.NODE_ENV === "production") {
        throw new AppError(
          503,
          "Media uploads are not configured (S3)",
          "S3_NOT_CONFIGURED",
        );
      }
      const mockUrl = `https://example-bucket.s3.amazonaws.com/${key}`;
      return res.json({
        success: true,
        data: {
          uploadUrl: mockUrl,
          publicUrl: mockUrl,
          key,
          mock: true,
        },
      });
    }

    const command = new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET_NAME,
      Key: key,
      ContentType: parsed.data.contentType,
    });
    const uploadUrl = await getSignedUrl(s3Client(), command, { expiresIn: 900 });
    const publicUrl = publicUrlForKey(key, uploadUrl);

    res.json({
      success: true,
      data: { uploadUrl, publicUrl, key, mock: false },
    });
  }),
);

/**
 * Server-side upload — avoids browser CORS failures on direct S3 PUT.
 * Body: raw image bytes. Query: folder, ext. Header: Content-Type.
 */
mediaRouter.post(
  "/upload",
  requireAuth,
  express.raw({
    type: "*/*",
    limit: "12mb",
  }),
  asyncHandler(async (req, res) => {
    const contentType = String(req.headers["content-type"] || "image/jpeg")
      .split(";")[0]
      .trim();
    if (!contentType.startsWith("image/") && contentType !== "application/octet-stream") {
      throw new AppError(400, "Content-Type must be an image", "VALIDATION_ERROR");
    }

    const folderRaw = String(req.query.folder || "listings");
    const folder = folderRaw === "profiles" ? "profiles" : "listings";
    const ext = normalizeExt(
      typeof req.query.ext === "string" ? req.query.ext : undefined,
      contentType,
    );
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
    if (!body.length) {
      throw new AppError(400, "Empty upload body", "VALIDATION_ERROR");
    }
    if (body.length > 12 * 1024 * 1024) {
      throw new AppError(413, "File too large (max 12MB)", "PAYLOAD_TOO_LARGE");
    }

    const key = `${folder}/${req.userId}/${randomUUID()}.${ext}`;

    if (!s3Configured()) {
      if (env.NODE_ENV === "production") {
        throw new AppError(
          503,
          "Media uploads are not configured (S3)",
          "S3_NOT_CONFIGURED",
        );
      }
      const mockUrl = `https://example-bucket.s3.amazonaws.com/${key}`;
      return res.json({
        success: true,
        data: { publicUrl: mockUrl, key, mock: true },
      });
    }

    await s3Client().send(
      new PutObjectCommand({
        Bucket: env.AWS_S3_BUCKET_NAME,
        Key: key,
        Body: body,
        ContentType: contentType.startsWith("image/")
          ? contentType
          : `image/${ext === "jpg" ? "jpeg" : ext}`,
      }),
    );

    const publicUrl = publicUrlForKey(key);
    res.json({
      success: true,
      data: { publicUrl, key, mock: false },
    });
  }),
);
