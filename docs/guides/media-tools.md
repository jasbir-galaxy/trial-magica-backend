# Typed media tools

The agent exposes Crop Image, GPT Image 2 (text and edit), and Merge Videos to `openrouter/free`. No paid LLM fallback or media success stub is used in the application.

## Configuration and use

Set server-only `MAGICA_API_KEY` and `MAGICA_API_BASE_URL` in `.env.local` and in the Trigger.dev environment. Use the supplied trial key and host, normally `https://inference.magica.com`. Restart the dev worker after changing environment variables. Never put the key in a frontend variable, prompt, or test fixture.

Ask in chat to generate an image, crop a public HTTPS image URL using a complete rectangle, or merge 2–100 ordered public HTTPS video URLs. The model selects tools and can pass a generated image URL to Crop Image. Edit requests use the image-edit submodel. Owned direct uploads are also available; see [uploads](uploads.md) for setup and recovery.

The registry fetches the live model catalog and composes GPT Image 2's text/edit schemas from it. Catalog select options supplement permissive preprocessor fields; advanced constraints absent from public JSON Schema remain enforced by Magica. The validated schema and hash are pinned per invocation. Adding unrelated provider fields is not permitted.

## Execution and recovery

The provider-neutral model loop assembles streamed function arguments before executing anything, limits a turn to six model steps/eight tool calls, and preserves ordered text/tool blocks. Independent calls use one typed Trigger.dev child batch; follow-up model calls receive ordered validated results. PostgreSQL is authoritative; realtime text snapshots include block ordering and owned REST reads hydrate current tool state and assets.

Unique `(runId, callId)` records protect dispatch. The child claims its row before POST, saves the Magica receipt before polling, and validates both pinned inputs and outputs. A terminal row lock settles usage once, even if two pollers observe completion. Aggregate credits use BIGINT storage and safe JSON numbers; the UI formats tool usage in M credits. Assistant-written prose still needs the correction recorded in [hosted acceptance](hosted-acceptance.md). The [credits and media approvals layer](credits-and-approvals.md) now reserves application funds, pauses for review of exact inputs and estimates, and settles actual usage once through an append-only ledger.

The public run API does not document caller idempotency. An ambiguous POST cannot safely be repeated: the invocation becomes `unknown`, blocks identical unresolved submissions in that chat, and asks for operator reconciliation. Known receipts are read again, never reposted. A bounded recovery sweep resumes pending receipts, including after the parent failed or stopped. Stopping a reply prevents new tools; media already submitted may finish and is still reconciled and accounted for. There is no documented public media-cancel endpoint.

Reads retry temporarily unavailable/rate-limited statuses with bounded backoff; each child polling window is nine minutes. The recovery sweep checks at most 25 tools per tick. The parent has a 30-minute bound. Failures keep partial text, completed assets, safe errors and usage. A failed media turn can be continued with a new follow-up; the UI does not silently reissue all prior paid tools through a generic reply-retry button.

## Migration and compatibility

Apply `pnpm db:deploy`, then `pnpm db:generate`, before starting the new worker/API. Migration `20261029001000_typed_media_tools` adds ToolInvocation, composite ownership foreign keys, dispatch/ordering uniqueness and recovery indexes; it widens aggregate credits and replaces the old zero-only check with nonnegative accounting. Existing text-only rows remain valid. Message tools and realtime content blocks are additive fields, but frontend rendering must be upgraded before enabling media tools because older clients only understand text blocks.

Rollback: disable media dispatch first; retain tool rows and assets for users. Revert application code only to a reader that tolerates tool blocks and nonzero usage. Do not drop ToolInvocation or restore the zero-only constraint after billable work exists. A destructive development-only rollback requires exporting tool records and removing their message anchors, then dropping the table, composite AgentRun index and ToolStatus enum; narrow BIGINT only after checking every value fits INT. Prefer a forward fix once real jobs exist.

## Verification

Unit fixtures cover the live catalog snapshot, schema changes, complete crop rectangles, ordered video limits, streamed tool fragments, API authentication/rate limits/timeouts and bounded loop chaining. PostgreSQL integration tests cover idempotent rows, exactly-once usage, receipt recovery, ambiguous submissions, cancellation, ownership and persisted ordered outputs. Fixtures are failure/contract evidence, not proof of real media generation. Real conversations with the supplied trial key were verified on October 29, 2026 (Asia/Kolkata); retain these local records for the demo and repeat acceptance in the deployed environment before submission.

Malformed model arguments receive safe field-level feedback and at most two correction attempts, only when the entire batch was rejected before admission. Executed or unresolved provider work is never automatically repeated through this correction path.

Media polls use ten-second durable waits (with bounded backoff), exceeding the SDK checkpoint threshold so long-running jobs do not keep compute occupied between checks.


### Real API acceptance

Each row below completed through the normal signed-in composer, OpenRouter Free selection, durable parent/child tasks, Magica API, PostgreSQL readback and rendered output. No direct/manual model selector was used. The five successful turns contain six completed tool rows with distinct provider receipts; each turn's aggregate usage equals its tool usage. The chain's crop input URL exactly matches its generation output URL.

| Case | AgentRun ID | Verified output | Usage |
| --- | --- | --- | --- |
| Crop Image | `5b8181f9-6451-44a5-bd6d-f7a02bbcf208` | Actual 320×240 image at the requested pixel rectangle | 0.005M credits |
| GPT Image 2 text | `3d719e65-e86b-41f6-a505-36c70f5d75d8` | Actual 1024×1024 red circle image, Low quality | 0.007644M credits |
| Merge Videos | `4c081920-9cfd-4547-9fda-fe03d2b38037` | Two ordered flower clips, no transition; playable 960×540 video, 10.133 seconds | 0.008445M credits |
| Generate → crop | `3e5c80f7-4337-4965-bbb0-33ea58373834` | 1024×1024 source and actual central 512×512 crop; both restored after full reload | 0.012644M credits |
| GPT Image 2 edit | `a022807c-8450-4c95-91c7-a7921dcc3fb5` | `gpt-image-2-edit` changed the supplied red circle to green; actual 1024×1024 result | 0.273936M credits |

The first chain attempt (`3189156b-4d80-425f-950d-772a9fb6bfa7`) exhausted bounded input correction without creating a tool row or charge. It remains visible as a failed turn. After clearer argument-shape guidance, the retry completed; invalid crop arguments were corrected before dispatch without duplicate provider work.

Model intent fidelity remains a limitation: an earlier percentage crop was interpreted as a 50×50 pixel crop, and the edit omitted the requested Low quality and used the catalog's High default. The pixel-specific crop and chain passed; the edit proves the real editing integration, not adherence to every requested setting. The assistant's statement that the edit used Low quality is inaccurate; persisted tool input and usage are authoritative. These initial conversations predate media approvals. New media invocations now show their actual settings and estimated price before submission, backed by application reservations and settlement. Estimates remain temporary holds, not final spending caps; approval does not guarantee that the model selected the settings requested in prose. These tests consumed 0.312669M trial credits including the earlier 50×50 crop; no service purchase was made.

Realtime verification found that a 1,800-second subscription returned HTTP 400 (`Timeout seconds must be less than 600`). The shared contract now sets a 300-second transport timeout, independently of the 30-minute durable task bound. The same completed stream returned HTTP 200 with that setting, and a fresh text reply completed without a new connection error. REST reconciliation remains available for transport failures. The SDK supports cursor resumption and bounded latest-value subscriptions; see [Trigger.dev's realtime changes](https://trigger.dev/changelog/v4-5-14).

The initial tool-loop slice passed 75 backend unit tests, 40 PostgreSQL integration tests and 35 frontend tests, plus TypeScript and lint in both repos. The subsequent [credits and approvals verification](credits-and-approvals.md#verification) brings the total to 169 tests and includes both production builds. The [on-demand skills layer](on-demand-skills.md) subsequently passed 198 tests and both production builds. Those counts describe the earlier slices. See [hosted acceptance](hosted-acceptance.md) for the later production verification and remaining fidelity, scale and submission work.
