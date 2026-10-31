# Hosted acceptance

Use this procedure after a release to distinguish configuration/build success
from a working deployed conversation. Keep failed attempts and their receipts;
do not present a successful retry as a flawless first attempt.

## Verified release

Acceptance on 2026-10-31 used the existing trial accounts and free service plans:

| Surface | Revision |
| --- | --- |
| Frontend | `0f3850efcd196c603ef67bfe8bc70d38e97a4430` on [Vercel](https://trial-magica-frontend.vercel.app) |
| Backend | `8da07c9b83d79024aa6fedc4e40d22f28346a8f0` on [Vercel](https://trial-magica-backend.vercel.app) |
| Trigger worker | Production `20261031.1`, built from the backend revision above |
| Database | Hosted Neon PostgreSQL, with the committed migrations applied |

Both Vercel deployment records were Ready and associated with those main commits.
The production worker deployment completed in the existing Magica Trial project.
No database migration was added by the rich-message or browser-test changes.
Follow the [deployment guide](deployment.md) for rollout and rollback order.

## Repeatable checks

1. Verify the frontend, API and worker revisions before starting a conversation.
   A local worker is not proof that the production worker has the same source.
2. Sign in and send a text request in Plan mode. Reload while waiting, approve,
   and verify one completed reply with saved usage. Stop a separate waiting run
   and check cancellation remains visible after another reload.
3. Run the frontend's `pnpm test:e2e` using its documented dedicated Clerk test
   user and explicit hosted opt-in. It exercises real services, including a lost
   response after server acceptance. The request ID must be reused on retry.
4. Ask for each required media operation through normal chat. Review actual
   settings before approval. Verify the returned files themselves, not just the
   assistant's description. Generate then crop in the same turn; reload between
   the media approvals and verify both outputs after completion.
5. Use scoped, read-only database checks for those chat/run IDs: one assistant
   row per run, unique provider receipts, matching tool/turn/ledger totals,
   released reservations, and persisted skill versions. Keep credentials and raw
   logs in private local evidence, outside Git.

The frontend browser suite and its setup/coverage guide are in
[frontend PR 5](https://github.com/jasbir-galaxy/trial-magica-frontend/pull/5).
All four scenarios passed across the initial run and the corrected management
rerun. The initial management failures were test locator/navigation timing errors.
The frontend also passed 79 unit/component tests, type checking, lint and build.
These tests do not replace the provider acceptance below.

## Real hosted conversations

All media success paths used OpenRouter Free, typed tools, durable Trigger parent
and child tasks, the supplied Magica API, human approval, and PostgreSQL readback.
No media success response was stubbed or selected through a manual model picker.

| Case | AgentRun | Observed result | Usage |
| --- | --- | --- | --- |
| Plan/reload/approve | `b390e841-2839-4792-a5f1-9a6ebe8941d0` | Plan survived reload and resumed to answer 17 × 23 = 391 | 0M credits |
| GPT Image 2 text | `cad6db86-ef3c-4ad8-9822-483152472fdb` | Blue-circle PNG generated and restored after reload; actual 1254×1254, **not the requested 1024×1024** | 0.008931M credits |
| Crop Image follow-up | `603245be-2906-46de-8727-246e4a21687c` | Actual 512×512 PNG at the explicit x=256/y=256 rectangle; source was the preceding 1254×1254 image, so this was **not its exact center** | 0.005M credits |
| Merge Videos | `cecf3ed3-29fb-460a-9578-6d5f96bc6291` | Two ordered URLs, no transition; 960×540 output, browser playback showed about 15 seconds; restored after reload | 0.012675M credits |
| Generate → crop in one turn | `95cc0b72-05c1-4595-9870-3f9498b6b307` | Low-quality 1024×1024 PNG, then exact center 512×512 PNG; actual file dimensions checked, source URL reused exactly | 0.012644M credits |

The chain loaded `image-composition` on demand and persisted one RunSkill receipt
with hash `9504e709eccbec057e3ab533aeda76d6fbfe8af0071ef8d3c5d4abfca8626a13`.
Reloading while its crop awaited approval preserved the generated asset, loaded
skill card and the precise crop settings. Its first attempt,
`f8d1aaba-1c23-4f38-bed4-c7713bc4a9c6`, failed after bounded argument corrections,
created no tool rows, and charged 0M credits. The normal Retry control started
the successful turn; the failed reply remains visible.

Scoped reconciliation covered six runs (five completed, one failed), five
completed billable media tools and two zero-cost guidance/plan tools. Every run
had one assistant row. Every reservation was settled; each reserve/settle kind
had one ledger entry, net held credits were zero, and actual charges matched the
tool and turn totals. All five provider receipts were distinct. Total media
usage for these acceptance conversations was 0.03925M credits. This is evidence
for these runs, not a claim that every possible race has been load-tested.

## Hosted signed webhooks — October 31

A temporary synthetic API account exercised the deployed public REST API and
production worker. Account/key/subscription setup used the backend service layer;
chat creation, direct Crop Image submission, approval, and run reads used HTTPS
at the hosted origin. This verifies delivery and execution, not the settings UI.

- Chat: `010fcac4-a9bc-45b0-8144-7c7dcf247500`.
- Run: `a4da335b-bf24-4e49-8711-317839301b57`.
- Crop result: 64×64, settled once at 0.005M credits.
- `agent.started`, `agent.completed`, and `tool.completed` each arrived once with
  HTTP 204. All three raw-body HMAC signatures verified at the temporary receiver.
- The endpoint was disabled, its API key revoked, and receiver records removed.
  The first setup attempt hit a cold database transaction timeout before starting
  any media work; the retry opened the connection before setup.

This adds hosted success-path webhook evidence. Failure, retry, tampering,
deduplication, and ownership remain covered by the automated suites; they were
not all fault-injected against production.

## Remaining submission work

- **Intent and output accuracy:** the first generation omitted the requested
  size and the assistant incorrectly described its dimensions. The explicit-size
  chain passed. Tighten model guidance and output verification before claiming
  consistent adherence to requested settings; do not silently regenerate media.
  [The reliability release](agent-reliability.md) adds explicit model settings
  and bounded image-header inspection; its hosted rollout is still pending.
- **Credit and error copy:** the merged-video assistant prose used raw units
  while its tool card correctly displayed 0.012675M credits. The malformed-tool
  terminal message exposes schema terminology. Improve assistant-facing credit
  context and user-facing validation recovery without changing numeric billing
  contracts or hiding the saved failure. The reliability release implements
  these boundaries and covers current and restored conversation context.
- **Hosted breadth:** upload/reconnect/quota still need hosted acceptance.
  Signed outbound success delivery is verified above. Image editing has prior real local evidence;
  it was not rerun against this deployment. File selection remains manual.
- **Scale and context:** 1,000 concurrent agent turns are not measured. Existing
  UI virtualization evidence is not a worker load test. Long-history context
  remains bounded and needs the separately planned summary/retrieval work.
- **Fidelity and accessibility:** finish comparison with Galaxy and broader
  browser/device coverage; the small Chromium suite does not establish full parity.
- **Submission:** the [Mintlify site](https://jasbir-magica-trial.mintlify.site)
  is published, claimed by the trial owner, and uses the hosted API origin.
  Its interactive API reference and internal links have been verified. Record
  the five-minute demo and verify reviewer login access using the
  [submission checklist](submission.md).

The deployment and primary media paths are verified. The complete work-trial
brief is not yet satisfied; this guide must not be used as a blanket sign-off.
