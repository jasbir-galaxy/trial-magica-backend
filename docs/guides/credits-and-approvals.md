# Credits and media approvals

Migration `20261029030000_credit_approvals` adds per-user credit accounts, reservations, an append-only ledger and media waitpoints. It backfills AgentRun ownership from Chat before enforcing the required field and composite foreign keys. Existing runs, messages, tool receipts and usage are retained. Historical tools without a reservation are not charged retroactively.

Deployment: stop new admissions and drain active media work; apply `pnpm db:deploy`, regenerate Prisma and deploy matching workers/API/frontend together. Configure `TRIAL_INITIAL_CREDITS` explicitly in the API and worker environments; its default is zero. This is an application trial allocation, separate from the shared upstream account's actual balance. It does not purchase credits or enable paid LLM fallback. OpenRouter usage remains 0M credits.

Rollback: prefer a forward fix. Disable admissions and wait for submitted work to settle before reverting. Preserve all credit/approval tables and ledger history. An older worker bypasses approvals and must not be re-enabled for media dispatch. A destructive development rollback requires exporting these records first, removing ledger and reservation foreign keys/tables, waitpoints and accounts, restoring AgentRun's simple chat foreign key, then dropping AgentRun.userId and its composite indexes. PostgreSQL enum additions may remain unused; do not rebuild the enum while rows or readers use it.

Estimates reserve funds and are not spending caps. Final usage releases the hold and charges actual usage exactly once. Already-incurred overage is recorded even when it creates debt; future admission blocks. Rejected, expired and cancelled unsubmitted work releases its hold. Unknown submissions retain their hold pending receipt reconciliation.

## Approval lifecycle

Every new media invocation uses the same policy: fetch its estimate, reserve credits, persist an approval with the exact input fingerprint, then create an idempotent ten-minute Trigger.dev waitpoint. The child task checkpoints during the human wait. No media POST occurs before an authenticated approval, matching fingerprint, live parent run and funded reservation. Inputs are validated again after resumption. Completed cached invocations reuse their result without a new hold or approval.

The browser receives an application approval ID, settings, estimate and expiry; it never receives the Trigger completion URL or completion credential. `POST /api/app/v1/approvals/:approvalId` validates ownership and records the first decision before waking the task. Duplicate matching decisions are safe. Conflicting, stale and cross-owner decisions are rejected. A bounded recovery outbox retries lost wakeups; the database decision, not arbitrary token output, authorizes execution. Rejected, expired and stopped tasks become visible cancelled tool cards. The containing reply can terminate with a clear failure when its requested tool is declined or expires; completed earlier outputs remain available.

`GET /api/app/v1/credits` returns balance, reserved, available and refundable turn-admission amount. `GET /api/app/v1/credits/ledger?limit=20&cursor=...` returns stable cursor-paginated ledger entries. Values retain integer internal units; all UI amounts use M credits. No client grant, purchase or balance-edit endpoint exists.

A final funding check before submission catches a reservation made underfunded by another completed job's overage. Already-submitted jobs still reconcile and settle actual usage; they are never reposted or cancelled just because an estimate was exceeded. Unresolved submissions keep their hold until operator reconciliation.


## Verification

Local acceptance on October 29, 2026 (Asia/Kolkata) used the signed-in frontend, real OpenRouter Free, the existing Magica Trial worker and the supplied Magica API. The conversation is retained at `/chats/f4f9762a-57d2-462b-8f91-a0fdbc8784a3`.

- Approved crop, AgentRun `cc7f6457-3030-4359-85ab-ae0d2a64e376`: before approval the tool had no provider receipt and held 0.005M credits, alongside the 0.001M refundable turn admission. Reload restored the pending approval and settings. Approval resumed Trigger run `run_06go8knel069elj4e8oa87e9a2`; the real 320×240 output persisted and settled once at 0.005M credits.
- Declined crop, AgentRun `82ebf5d2-aa04-40b0-b95f-5b435bf21bbf`: the tool remained without a provider receipt, became visibly cancelled and released both holds with zero usage. The containing reply preserved its clear decline message and prior assets.
- Stopped text reply, AgentRun `29653dfa-3746-4671-8de0-7d5bd1838e40`: stopping preserved partial text, finalized cancellation and refunded admission. The account ended at 0.995M credits with 0M credits reserved, starting from the local 1M application trial allocation. Every reservation had exactly one settlement ledger entry.

Approval expiry and stopping a paused media task were verified in PostgreSQL integration tests, not in the live browser. Tests also cover cross-owner decisions, stale fingerprints, duplicate decisions and settlement, lost wakeup delivery, reservation races, funding denial, actual usage above and below estimates, cancellation and retained holds for ambiguous submissions.

Verification passed: 76 backend unit tests, 55 PostgreSQL integration tests and 38 frontend tests (169 total); TypeScript, lint and production builds in both repos; applied migrations in application and isolated test databases; and an empty Prisma schema drift comparison. Live checks exercised the authenticated credits, ledger, approval and stop routes through the browser and read back durable results from PostgreSQL.

## Remaining scope

This milestone is local and has not been deployed. The trial allocation is application bookkeeping, separate from the upstream account balance; there is no purchase, top-up or public billing API. This approval policy covers media tasks; plan and option waitpoints remain future work. OpenRouter Free can still return plain text in place of a tool call or malformed arguments; these outcomes stay visible and do not bypass approval. No 1,000-concurrent-turn benchmark has been performed. The [on-demand skills milestone](on-demand-skills.md) is now implemented. Uploads and reference UI fidelity are next.
