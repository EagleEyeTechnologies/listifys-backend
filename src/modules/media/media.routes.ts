import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { env } from "../../config/env.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../utils/AppError.js";
import { s3Configured } from "./s3.js";

export const mediaRouter = Router();

const presignSchema = z.object({
  contentType: z.string().min(3).max(100),
  ext: z.string().min(1).max(10).optional(),
});

export { s3Configured };

mediaRouter.post(
  "/presign",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = presignSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid payload", "VALIDATION_ERROR", parsed.error.flatten());
    }

    const ext = parsed.data.ext || "jpg";
    const key = `listings/${req.userId}/${randomUUID()}.${ext}`;

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

    const client = new S3Client({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
      },
    });

    const command = new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET_NAME,
      Key: key,
      ContentType: parsed.data.contentType,
    });
    const uploadUrl = await getSignedUrl(client, command, { expiresIn: 900 });
    const publicUrl = env.AWS_S3_BUCKET_URL
      ? `${env.AWS_S3_BUCKET_URL.replace(/\/$/, "")}/${key}`
      : uploadUrl.split("?")[0];

    res.json({
      success: true,
      data: { uploadUrl, publicUrl, key, mock: false },
    });
  }),
);
