# Durable text turns

This first execution slice provides authenticated text turns, OpenRouter Free streaming, PostgreSQL history and partial replies, Trigger.dev tasks, cancellation, scoped realtime access, and recovery. The [typed media tool layer](media-tools.md) adds the three Magica adapters, child tasks, result cards, and tool usage settlement. The [credits and media approvals layer](credits-and-approvals.md) adds refundable turn admission, media reservations, a ledger and durable human waitpoints. The [on-demand skills layer](on-demand-skills.md) adds secure typed loaders and pinned guidance versions. The [upload layer](uploads.md) is implemented; full reference fidelity remains a separate milestone. OpenRouter usage is recorded at zero application credits.

## Data and concurrency

Migration `20261028171000_agent_turn` adds AgentRun, nullable message errors, the tool role, composite message foreign keys, and a partial unique index enforcing one active run per chat. Existing chat/message data is retained. User and chat row locks serialize short admission transactions; no database lock spans model or network work. Request IDs are scoped to a chat and must be reused on ambiguous send failures. Reusing one with changed text is rejected.

Queued rows are the dispatch outbox. Dispatch uses a global idempotency key and a 15-second lease. Reopening a chat reconciles pending dispatch and stale runs. The `agent-run-recovery` minute schedule sweeps bounded batches. This installed Trigger.dev version also activates it while the local worker is running; chat polling provides a second reconciliation path. Each task claims once, disables automatic model-call replay, and persists snapshots plus idempotent terminal status. Crashes retain the last durable snapshot (up to 750ms behind the stream), then reconcile to a visible retryable failure after the 30-minute media-capable run deadline. Stream transport loss does not stop the durable task.

Context reads the latest 40 completed messages up to 60,000 characters, preserving whole messages. It does not yet summarize older context. Replies have a 90-second model deadline and 4,096 output-token cap. There is no paid model fallback. An incomplete or empty stream is a failed turn with any partial text retained.

## Migration and rollback

Apply with `pnpm db:deploy`, then `pnpm db:generate`, before starting the new API and worker. The migration is additive; old readers retain their original fields. Message pagination adds optional `order=desc`; existing default ascending reads keep working and cursors cannot cross sort orders. Error fields are optional in the shared response schema.

For application rollback, first stop admission and drain/cancel active tasks, then deploy the previous API/frontend/worker while retaining this schema and historical run data. No destructive SQL rollback is required. If removing these additions later, export AgentRun and message errors first; drop AgentRun and its indexes/constraints before the composite Message index or error column. Keep the additive `tool` enum member to preserve stored data and avoid enum recreation. Never reset a populated database. The partial unique index and check constraints are maintained in SQL; Prisma schema introspection alone does not represent their predicates.

## Local verification

Run unit tests and the isolated `magica_trial_test` PostgreSQL suite, typecheck/lint, then `pnpm trigger:dev`. Send from the signed-in frontend, reload mid-turn, stop a reply, and verify persisted history. Never use production or another project’s secrets. Generated contracts are copied with `node scripts/export-contracts.mjs ../\"Magica Frontend\"/src/generated`.

## Local stream transport

The initial live run completed in PostgreSQL but Trigger streams v2 failed with an S2 connection timeout from this network. Local `.env.local` uses the SDK-supported `TRIGGER_V2_REALTIME_STREAMS=0` compatibility transport for subsequent runs. This is a local transport setting, not an LLM fallback. Snapshot transport is bounded to 8MB per run, and durable REST reconciliation remains available. Recheck v2 connectivity before deployment.

## API and acceptance evidence

- `POST /api/app/v1/chats/:chatId/turns`: strict `{ requestId, text, model?: "openrouter/free" }`, returns 202 `{ run, realtime }`.
- `GET /api/app/v1/chats/:chatId/turns`: owned latest run with durable message snapshots; reconciles dispatch/timeouts.
- `POST /api/app/v1/runs/:runId/stop`: idempotent owned cancellation.
- `POST /api/app/v1/runs/:runId/realtime`: owned read-only token for exactly one Trigger run.

Local browser checks on October 28, 2026 used the signed-in Clerk session and real OpenRouter. The first response survived a transport failure and appeared through durable REST reconciliation. Compatibility run `run_06go7anscf0sohu1ic8rl4t2a2` completed successfully, with two validated stream frames read back; reload during the run restored the same message IDs. A queued turn was stopped before execution and stayed visibly cancelled. Retry created a new turn; an actual free-model timeout remained visible with a retry path. No paid fallback was used.

Free-router quality varies: one real response returned a safety classification instead of answering the prompt. That output is retained honestly. Model selection remains the required free router. The supplied media credentials have since passed the [real tool conversations](media-tools.md#real-api-acceptance), including generation followed by cropping. The Next.js development navigation validator still shows a nonblocking warning; production builds succeed. Load testing for 1,000 concurrent turns and longer-context summarization have not been completed. Hosted text send/read/reload passed on October 31; the full hosted media and recovery matrix remains outstanding. The frontend now virtualizes history; its 1,000-message local verification is recorded in the frontend workspace guide.

Rich content and correlation logging are documented in [rich messages and diagnostics](rich-messages-and-diagnostics.md), including reader-first rollout and rollback constraints.
