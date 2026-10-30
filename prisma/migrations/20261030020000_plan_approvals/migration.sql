ALTER TABLE "AgentRun" ADD COLUMN "planMode" BOOLEAN NOT NULL DEFAULT false;
CREATE TYPE "ApprovalKind" AS ENUM ('media', 'plan');
ALTER TABLE "Waitpoint" ADD COLUMN "kind" "ApprovalKind" NOT NULL DEFAULT 'media';
-- One immutable plan proposal per turn, including proposals with different call IDs.
CREATE UNIQUE INDEX "ToolInvocation_one_plan_per_run" ON "ToolInvocation" ("runId") WHERE "name" = 'propose_plan';
