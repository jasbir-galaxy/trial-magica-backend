import { z } from "zod";

export const UPLOADS_PATH = "/api/app/v1/uploads";
export const ATTACHMENTS_PATH = "/api/app/v1/attachments";
export const UPLOAD_TASK_ID = "persist-uploads";
export const MAX_ATTACHMENTS = 5;
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
export const MONTHLY_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
export const UPLOAD_SIGNATURE_MS = 15 * 60_000;
export const UPLOAD_LIFETIME_MS = 6 * 60 * 60_000;
export const UPLOAD_URL_SECONDS = 2 * 60 * 60;
export const UPLOAD_OVERHEAD_BYTES = 16_384;
export const UploadMimeSchema = z.enum(["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime", "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/ogg", "audio/webm", "audio/flac"]);
export const AttachmentStatusSchema = z.enum(["uploading", "processing", "ready", "failed", "cancelled"]);
export const UploadStatusSchema = z.enum(["created", "uploading", "processing", "completed", "failed", "cancelled"]);
export const AttachmentIdListSchema = z.array(z.uuid()).max(MAX_ATTACHMENTS).refine(ids => new Set(ids).size === ids.length, "Choose each file only once.");
export const UploadFileSchema = z.strictObject({
  id: z.uuid(), name: z.string().trim().min(1).max(180).refine(value => !/[\u0000-\u001f\u007f/\\]/.test(value), "Use a file name without path separators or control characters."),
  mimeType: UploadMimeSchema, size: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
});
export const CreateUploadSchema = z.strictObject({
  requestId: z.uuid(), chatId: z.uuid(), files: z.array(UploadFileSchema).min(1).max(MAX_ATTACHMENTS),
}).refine(value => new Set(value.files.map(file => file.id)).size === value.files.length, "Duplicate file IDs.");
export const AssemblyIdSchema = z.string().regex(/^[a-z0-9]{32}$/);
export const BindAssemblySchema = z.strictObject({ assemblyId: AssemblyIdSchema });
export const UploadTaskSchema = z.strictObject({ uploadId: z.uuid() });
export const AttachmentSchema = z.object({
  id: z.uuid(), uploadId: z.uuid(), name: z.string().max(180), mimeType: UploadMimeSchema, size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  kind: z.enum(["image", "video", "audio"]), status: AttachmentStatusSchema,
  url: z.url().nullable(), urlExpiresAt: z.iso.datetime().nullable(), error: z.string().max(300).nullable(), createdAt: z.iso.datetime(),
});
export const UploadSchema = z.object({ id: z.uuid(), status: UploadStatusSchema, error: z.string().max(300).nullable(), attachments: z.array(AttachmentSchema).max(MAX_ATTACHMENTS), createdAt: z.iso.datetime() });
export const SignedUploadSchema = z.object({ upload: UploadSchema, params: z.string().max(16_000), signature: z.string().regex(/^sha384:[a-f0-9]{96}$/), expiresAt: z.iso.datetime() });
export const UploadPolicySchema = z.object({
  enabled: z.boolean(), message: z.string().max(300).nullable(), maxFiles: z.number().int().positive(), maxFileBytes: z.number().int().positive(),
  mimeTypes: z.array(UploadMimeSchema), monthlyLimitBytes: z.number().int().positive(), remainingBytes: z.number().int().nonnegative(),
});
export const AttachmentPageSchema = z.object({ items: z.array(AttachmentSchema).max(100), nextCursor: z.string().nullable(), hasMore: z.boolean() });
export const ResolveAttachmentsSchema = z.object({ items: z.array(AttachmentSchema).max(MAX_ATTACHMENTS) });
export const UploadListSchema = z.object({ items: z.array(UploadSchema).max(10) });
export type Attachment = z.infer<typeof AttachmentSchema>;
export type Upload = z.infer<typeof UploadSchema>;
export type CreateUpload = z.infer<typeof CreateUploadSchema>;
