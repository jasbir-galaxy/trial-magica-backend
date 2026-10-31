# Rich messages and correlated diagnostics

The authoritative content schema supports ordered text, tool references, attachments,
measured thinking activity, provider-supplied reasoning or summaries, citations,
and per-model-step usage. OpenRouter remains `openrouter/free` with no paid fallback.
The adapter accepts visible reasoning text/summary fields and ignores encrypted
reasoning and signatures. It does not invent reasoning when the provider omits it.
Malformed citation, media and webhook URLs return validation errors instead of
throwing URL-parser exceptions. Citation URLs must be HTTP(S) without credentials; no paid search plugin is enabled.

One bounded transcript supplies both stream snapshots and PostgreSQL readback.
Adjacent text/reasoning chunks coalesce; tool anchors retain execution order.
Thinking ends on visible text, tool execution, model usage or termination. Failure
and cancellation retain the saved partial transcript. Interrupted workers leave a
terminal “Thinking stopped” indicator instead of an indefinitely running timer.
Model accounting is saved before appending its display block, so a content limit
cannot discard received usage. OpenRouter application usage remains 0M credits.

The shared generated-asset contract now accepts audio as well as image/video.
The frontend uses native audio controls in result cards and artifact previews.
This adds no extra provider or tool; the audio persistence/rendering checks use a
clearly identified fixture. They do not claim a real audio-generation success.

## Diagnostics

Structured log metadata is allowlisted. No raw exception, credential, prompt,
provider payload, generated content or request headers are passed to the sink.
HTTP requests return `X-Trace-Id`; failed requests retain the existing JSON trace ID.
When a turn is dispatched, `requestTraceId` links that HTTP request to its durable
trace: the server-generated AgentRun UUID. The same `traceId`, `chatId`, `runId`
and assistant `messageId` are reconstructed from PostgreSQL after a restart.
`processId` identifies the OS worker and `triggerRunId` identifies the task.
Tool events also include `invocationId` and a saved `providerRunId` when available.
Approval wait/wakeup events include `waitpointId` and `waitpointTokenId`.

Start/finalization receipts are logged after their database transactions commit.
Repeated turn finalization does not emit another terminal receipt. Reconciliation
may log repeated tool observations; those are diagnostics, never billing records.
The credit ledger and unique settlement receipts remain the billing authority.

## Compatibility and rollback

No SQL migration is needed: these are new validated JSON content variants and an
additive asset kind. Existing text/tool/attachment messages and legacy text-only
realtime frames remain readable. Old strict clients cannot read new variants.

Deploy the updated frontend reader first. Then deploy the backend reader/API and
the matching Trigger worker writer. Refresh already-open tabs before acceptance.
Regenerate frontend contracts and the OpenAPI document from backend schemas.
For rollback, stop/drain new work and roll back execution while retaining the new
content schemas/readers in API and frontend. Do not deploy an older strict reader
over stored rich messages, rewrite history or delete reasoning/usage records.

## Verification

On October 31, 2026, real local Trigger run `run_06gp0sm25atepe1sk7tu28i6a2`
completed through OpenRouter Free. The UI showed supplied reasoning, a 2.7-second
thinking duration, the actual routed model and 3,612 input / 104 output tokens.
The answer and rich blocks survived a browser reload in chat
`bb9c005a-ad4e-4f09-b760-e676a46197f6`.

Run `run_06gp0ue6dofvb5p1tthufv94a2` then completed with matching start/finish
log identifiers under worker version `20261031.5`. Contract/parser tests cover
legacy messages, summaries, encrypted-field omission, unsafe citations, content
limits and accounting. Database tests cover failed partial replies, audio receipt
readback, HTTP/run correlation, duplicate finalization and approval wakeup logs.
UI tests cover durable ordering, stopped thinking, safe rendering, snapshot
replacement and native audio controls. Hosted acceptance remains a release check.
