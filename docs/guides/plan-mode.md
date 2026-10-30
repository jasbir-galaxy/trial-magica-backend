# Plan mode

`SendTurn.planMode` is optional and defaults to false on the server. It is part of
the idempotency comparison: the same request ID cannot switch modes. An enabled
turn exposes read-only skill loaders plus the typed `propose_plan` tool. The
proposal has one title and 1–8 ordered steps, validated before persistence.
The plan is stored as a normal tool invocation and rendered in message order.

One immutable proposal is allowed per run. A persisted waitpoint binds its input
hash, owner, deadline, decision and wakeup receipt. Plan review reserves no tool
credits; ordinary refundable turn admission still applies. Approval only opens
the plan gate; later media settings and credit approvals remain required.
Decline cancels the turn, expiry preserves a failed turn, and stop cancels pending
work. Duplicate decisions cannot change the stored choice or execute work twice.
The existing bounded recovery outbox retries wakeups and expires unanswered
reviews. The Trigger task suspends its cancellation polling timer during the
durable wait, then checks server state before continuing.

## Migration and compatibility

Apply `20261030020000_plan_approvals` and `20261030021000_plan_tool_contract` with `pnpm db:deploy`, then regenerate Prisma
with `pnpm db:generate`. Existing runs get `planMode=false`; existing waitpoints
get `kind=media`. The partial unique index `ToolInvocation_one_plan_per_run`
enforces one `propose_plan` invocation per run; it is managed by SQL because the
Prisma schema does not express this predicate.

Deploy the generated frontend contracts with the backend before enabling plan
mode. New fields are optional on the wire. Older consumers that strictly parse
tool-name enums need the new plan name/output contract to read plan history.

To roll back, first disable plan-mode submissions and drain/cancel active plan
runs and their wakeups. Keep readers that understand historical plan tool rows;
do not delete user-owned plan history. A previous backend needs those additive
reader contracts backported before it can serve chats containing plans. After
removing writers that depend on the new columns, the schema rollback is:

```sql
DROP INDEX "ToolInvocation_one_plan_per_run";
ALTER TABLE "Waitpoint" DROP COLUMN "kind";
DROP TYPE "ApprovalKind";
ALTER TABLE "AgentRun" DROP COLUMN "planMode";
```

Dropping these columns loses the explicit mode/kind metadata. Prefer a forward
fix that retains them; export the affected records before a destructive rollback.

The second migration additively admits the new plan tool name. Retain that check
constraint during rollback while historical plan rows exist; restoring the old
name list would reject those rows.


## Verification

On October 30, 2026, a real signed-in browser submitted a text-only plan from the
home composer. OpenRouter Free called `propose_plan`; the Trigger.dev task waited
for a decision. Reloading the conversation restored the same ordered steps and
approval controls. Approving resumed the same task and produced the requested
three-sentence welcome message. The completed reply survived another reload.

Local evidence: chat `2f28e04c-07c5-4f31-b595-57943d31ce95`, application run
`fe1ac4af-b965-463d-9f02-77900ba73856`, Trigger run
`run_06gorgdp7eo2t40f22qbuh8la2`, worker version `20261030.8`.
The saved route was `openrouter/free`; the actual routed model was
`dots-studio/dots-3-note-preview:free`. PostgreSQL readback confirmed one plan
invocation, one approved/delivered waitpoint, two messages, and 0M application
credits. The 0.001M-credit refundable admission hold was released exactly once.
This check did not call paid media providers.

The automated verification passed 113 backend unit tests, 94 PostgreSQL
integration tests and 63 frontend tests. Plan-specific coverage includes owner
and input-hash checks, immutable/idempotent decisions, no execution before
approval, decline, expiry, stop, false token wakeup, and request-ID mode mismatch.
Both repositories passed type checks, lint and production builds. Both plan
migrations were applied to the local application and isolated test databases.
Repeat the live flow after deploying the frontend, backend and Trigger worker;
local verification is not deployment acceptance.
