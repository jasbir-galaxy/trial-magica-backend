import { recoverUploads } from "../src/uploads/dispatch";
import { recoverApprovals } from "../src/approvals/store";
import { triggerApprovals } from "../src/approvals/trigger";
import { recoverMediaTools } from "../src/tools/recovery";
import { schedules } from "@trigger.dev/sdk";
import { getDatabase } from "../src/db/client";
import { ACTIVE, RUN_INCLUDE, runDto } from "../src/agent/run-store";
import { reconcileRun } from "../src/agent/dispatch";

export const runRecovery = schedules.task({
  id: "agent-run-recovery", cron: { pattern: "* * * * *", window: "5m" }, maxDuration: 60,
  run: async () => {
    const rows = await getDatabase().agentRun.findMany({ where: { status: { in: ACTIVE }, dispatchAfter: { lte: new Date() } }, orderBy: { dispatchAfter: "asc" }, take: 50, include: RUN_INCLUDE });
    for (const row of rows) {
      await reconcileRun(await runDto(row));
    }
    return { uploadsChecked: await recoverUploads(), checked: rows.length, toolsChecked: await recoverMediaTools(), approvals: await recoverApprovals(triggerApprovals.complete) };
  },
});
