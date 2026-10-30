import { schemaTask } from "@trigger.dev/sdk";
import { UPLOAD_TASK_ID, UploadTaskSchema } from "../src/contracts/uploads";
import { processUpload } from "../src/uploads/process";
export const persistUploads = schemaTask({
  id: UPLOAD_TASK_ID, schema: UploadTaskSchema, maxDuration: 600,
  queue: { concurrencyLimit: 10 }, retry: { maxAttempts: 1 },
  run: async ({ uploadId }, { signal }) => processUpload(uploadId, { signal }),
});
