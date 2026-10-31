# Agent reliability release

This release addresses failures observed during [hosted acceptance](hosted-acceptance.md):
missing requested image settings, unsupported dimension claims, raw credit units
in replies, and schema details in terminal errors. It also handles a worker that
cannot finalize its PostgreSQL row during a database outage.

## Behavior and compatibility

The current Magica catalog still owns image fields. The model-facing schema
requires explicit size and quality when those fields exist and exposes the
`subModelId`/`input` envelope at the root. Ordinary public API requests retain
their existing optional defaults. Crop fields are also exposed at the root
while all complete-rectangle and unit constraints remain authoritative. Each invocation pins the exact validated
schema, so retries validate the original contract after catalog changes.

Successful tool results enter the model with `creditUsage` formatted in M
credits. Stored outputs, billing math, API responses, and settlements retain
their existing integer units. The same projection applies when rebuilding
conversation history. Exhausted input correction ends with a safe, retryable
message; detailed field feedback remains available to the model for correction.

Image outputs missing dimensions receive a best-effort header inspection.
Only PNG, JPEG, and WebP are parsed; downloads are capped at 256 KiB, with a
five-second request deadline and three-second DNS deadline. Public IPv4 is
resolved and pinned to the HTTPS connection, redirects are rejected, and at
most four inspections run concurrently. This reads dimensions, not image pixels
or semantic content. Failed inspection never discards a paid asset, changes its
charge, or starts another generation. Missing dimensions remain unverified.

REST reads and the recovery task use a shared 15-second per-run lease to check
the durable worker receipt. A terminal worker with a still-active database row
becomes a visible failed or cancelled turn, preserving partial output and
settling its admission once. Temporary status-API failures leave the run active.
Concurrent successful finalization wins. The existing 30-minute safety deadline
remains a final bound; no failed worker or ambiguous media submission is replayed.

## Verification

Regression tests cover explicit image choices with API compatibility, fresh and
restored credit presentation, safe terminal input errors, private-network and
redirect rejection, bounded image reads, cancellation, and retained paid assets.
The network test reproduces the real response-abort race encountered during
header inspection and verifies that a successful result wins before closing.

Real header reads verified the existing 1254×1254, 1024×1024, and 512×512 hosted
outputs. After a local Docker outage, run
`2ee0676c-aec7-47eb-a689-a76304e9d9df` changed from stuck thinking to a visible
interruption with Retry, and its admission hold was released. The next attempt
hit the free model's 90-second deadline, retained its failed turn, and charged
0M credits. These are real failure-path checks, not simulated provider successes.

The real local image run `fd65b0f6-d721-4dc6-9fb1-83aa6a6b2cf4` selected
1024×1024, Low quality, one PNG, and persisted the measured 1024×1024 output.
The free model then produced invalid crop arguments; the turn failed safely and
kept its completed image and 0.007644M-credit settlement. After exposing crop
fields at the schema root, follow-up run `5b007ca9-99b8-4619-bb10-d5c214aad117`
reused that exact saved image, selected `(256, 256, 512, 512)`, and returned
512×512. Its approval survived reload. The final assistant reply correctly
reported 0.007644M + 0.005M = 0.012644M credits. Database readback confirmed
exactly two media invocations, distinct receipts, matching turn/tool totals,
and no unsettled holds. This proves follow-up recovery and credit presentation;
it does not claim every routed free model completes a chain in one turn.

The backend passes 168 unit tests, 118 isolated PostgreSQL integration tests,
TypeScript, lint, and its production build. The Mintlify build and link checker
pass; the live site is published and claimed. See the hosted acceptance guide
for earlier successful conversations and remaining submission checks.

## Deployment and rollback

No schema migration or new environment variable is required. The existing
frontend already reads optional asset dimensions. Deploy this backend and its
matching Trigger worker together after review. Re-run the normal generation /
crop conversation against that hosted revision before marking rollout complete.

Rollback both execution processes to the prior release. Keep stored receipts,
dimensions, schema snapshots, and numeric credit records: they remain compatible.
Do not replay uncertain provider submissions. The docs site is independently
hosted under the owner's Mintlify account; connect its GitHub source in the
dashboard before relying on automatic documentation updates.
