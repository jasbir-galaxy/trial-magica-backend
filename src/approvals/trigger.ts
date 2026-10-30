import "server-only";
import { wait } from "@trigger.dev/sdk";
import type { ApprovalDriver } from "./store";
export const triggerApprovals: ApprovalDriver = {
  async create(id, expiresAt) {
    const token = await wait.createToken({ timeout: expiresAt, idempotencyKey: `media-approval:${id}`, idempotencyKeyTTL: "30d", tags: [`approval:${id}`] });
    return token.id;
  },
  async wait(tokenId) { await wait.forToken<{ recorded: boolean }>(tokenId); },
  async complete(tokenId) {
    const result = await wait.completeToken(tokenId, { recorded: true });
    if (!result.success) {
      const saved = await wait.retrieveToken(tokenId);
      if (saved.status !== "COMPLETED" && saved.status !== "TIMED_OUT") throw new Error("Approval wakeup was not acknowledged");
    }
  },
};
