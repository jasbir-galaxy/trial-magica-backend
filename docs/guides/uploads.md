# File uploads and attachments

Use Transloadit Community only. Configure the settings listed in `.env.example` in backend `.env.local` and the same Trigger.dev environment. Never put upload or storage secrets in the frontend. `TRANSLOADIT_AUTH_KEY` is the public key included in signed parameters; the secret stays on the server.

Choose a private S3-compatible bucket in your own trial account. Configure its HTTPS endpoint, region, bucket, access key and secret. The scoped storage key needs Head/Get/Put/Delete permissions only for `uploads/*`. Leave bucket public access disabled. The backend worker streams verified uploads into storage and the API returns short-lived signed read URLs. Do not enable paid overage. Storage providers have their own free allowances; choose one before configuring it.

Run `pnpm uploads:check` to validate settings without printing keys. Restart the API and `pnpm trigger:dev` after changing environment variables. For deployed callbacks, set `UPLOAD_PUBLIC_API_ORIGIN` to the HTTPS backend origin. `/api/uploads/webhook` verifies the exact HMAC-SHA1 notification before reconciling its receipt. Local development uses authenticated browser callbacks and worker recovery.

The composer uses Uppy Transloadit (tus) and Golden Retriever. Select up to five image, video or audio files. Progress, pause/resume, retries and restored transfers are local to the signed-in user and chat. Stable attachment IDs preserve direct-upload and library order. Send is enabled only after selected attachments have been saved. Completed media can be reused through the paginated library.

## Free B2 setup

Create a private, encrypted trial bucket. Keep the account's $0 storage/download caps and do not add a payment card. Use a non-master application key with read/write access restricted to this bucket and `uploads/`; listing file versions is needed for cancellation cleanup. Keep the bucket-name listing permission disabled. A 30-day key is sufficient for the trial; replace it before expiry if the deployment remains active.

Set `UPLOAD_S3_ENDPOINT=https://s3.<region>.backblazeb2.com`, `UPLOAD_S3_REGION=<region>`, `UPLOAD_S3_BUCKET=<bucket>`, `UPLOAD_S3_PROVIDER=backblaze-b2`, and `UPLOAD_S3_FORCE_PATH_STYLE=true`. The B2 `keyID` maps to `UPLOAD_S3_ACCESS_KEY_ID`; `applicationKey` maps to `UPLOAD_S3_SECRET_ACCESS_KEY`. Store these only in backend/worker environments. No public bucket or browser storage credentials are needed.

B2's free account has its own storage, download, and request caps; these are separate from the upload-processing allowance. Exhaustion must fail visibly without upgrading. Verify actual private reads, signed downloads, repeat saves, and version cleanup before acceptance. See [B2 version deletion](https://www.backblaze.com/apidocs/s3-delete-object).

## Contracts and recovery

- `GET /api/app/v1/uploads/config`: server-owned eligibility, MIME and byte limits.
- `POST /api/app/v1/uploads`: reserve quota and sign a fixed Assembly manifest, idempotent by owner/request ID.
- `POST /api/app/v1/uploads/{id}`: bind an authenticated Assembly receipt; bodies cannot supply result URLs.
- `GET /api/app/v1/uploads/{id}`: persisted progress and safe errors.
- `POST /api/app/v1/uploads/{id}/cancel`: cancel unfinished attachments; preserve saved files.
- `GET /api/app/v1/attachments`: owned ready-media cursor page.
- `POST /api/app/v1/attachments/resolve`: resolve up to five owned IDs in requested order.
- Chat send accepts ordered `attachmentIds`; ownership and ready state are checked before any messages are persisted.

`persist-uploads` claims a database lease, validates the completion manifest and detected MIME/size, then streams bytes to deterministic private object keys with MD5 and provider-appropriate writes. Generic S3 uses conditional writes. For Backblaze B2, set `UPLOAD_S3_PROVIDER=backblaze-b2`: PostgreSQL pins each file’s source ID and checksum under the upload lease before the first storage attempt, and retries verify the existing object receipt before writing. Changed receipts fail closed; a stale worker cannot terminate its replacement. B2 cleanup removes exact object versions, including delete markers, with bounded reads. An ambiguous overlapping B2 write can create another identical storage version; it cannot publish a second attachment or charge. Other S3 providers keep conditional writes enabled. A crash after storage succeeds is recovered with a matching object receipt. Cancellation and ready-state publication lock the same upload row. The recovery cron dispatches bounded batches; failed files remain visible. No long transaction spans a provider call.

The application enforces a 512 MiB file cap and a 5 GiB monthly admission budget shared across the configured account. Ambiguous/cancelled transfers retain their usage reservation conservatively. Provider usage above the reservation is recorded; Community itself stops processing at its cap. Use a dedicated trial provider account: external uploads are not visible to this application's ledger. Provider billing follows its own accounting cycle; the application budget uses UTC calendar months.

Assembly creation is not provider-idempotent: never restart a transfer just because the callback timed out. Golden Retriever stores the Assembly receipt and the API rejects replacement receipts. Lost browser storage before receipt binding expires safely after six hours, with no automatic replacement Assembly. Large local files can exceed browser storage quotas; the UI must ask for reselection instead of claiming full recovery. Temporary provider URL expiry fails visibly; only private copied files become ready. Image/audio/video metadata and URLs are supplied to the agent for tools; this does not add vision or audio understanding to the text model.

## Processed result sizes

Community image watermarking and audio/video trimming can change the output byte count. `Attachment.size` retains the originally admitted byte count; nullable `storedSize` records the actual bounded result size alongside its pinned source ID and MD5 before storage. The API reports `storedSize ?? size`. Storage verifies the copied bytes against the result size/hash, and subsequent receipts cannot change the pinned values. MIME, ownership, signed manifest, count, and file-size limits remain enforced.

## Migration and compatibility

`20261030000000_attachment_stored_size` adds one nullable integer with a positive, bounded-byte check. Apply this additive migration before the new worker/API, then regenerate Prisma. Existing ready attachments fall back to their original size, which the previous implementation required to match stored bytes; no table-wide backfill is needed. Duplicate terminal receipt callbacks return persisted state without restarting cleanup.

Rollback: stop upload admission/workers before reverting application code. Keep the nullable column and all stored objects; the preceding schema tolerates the additional column. Do not drop the column while retaining processed attachments whose sizes differ. Export those receipts and stored-size metadata before any later destructive rollback.


`20261029000000_uploads` adds UploadQuota, UploadBatch, Attachment and MessageAttachment with ownership foreign keys and stable cursor indexes. Existing chats/messages/runs remain unchanged. New API fields are optional; old text-only clients keep working. Apply with `pnpm db:deploy`, then `pnpm db:generate` and regenerate frontend contracts.

Rollback: stop upload admission/workers first and deploy the preceding app version. Keep the new tables and private objects to preserve user data; additive tables do not affect the previous version. A destructive rollback requires exporting attachment links and objects before dropping MessageAttachment, Attachment, UploadBatch and UploadQuota in that order, then their enums. Never roll back by deleting user files.

## Acceptance

Run unit and isolated PostgreSQL integration tests, both app checks/builds, then the real worker. With trial credentials configured, upload an image/audio/video, interrupt and resume a transfer, reload, select mixed library/new files, send and use an uploaded image with Crop Image. Verify the persisted receipt, one object per file, ordering, another user's denial, quota/invalid-file errors and cancellation during storage. Fixture success validates orchestration only and does not replace the real provider acceptance run.

References: [Uppy Transloadit](https://uppy.io/docs/transloadit/), [Golden Retriever](https://uppy.io/docs/golden-retriever/), [Community plan](https://transloadit.com/pricing/), [request signatures](https://transloadit.com/docs/api/authentication/), [Assembly status](https://transloadit.com/docs/api/assemblies-assembly-id-get/).
