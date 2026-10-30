# On-demand application skills

The application owns three guidance bundles under `agent-skills/`: image composition, precise cropping and video assembly. Add a folder with a matching lowercase hyphenated name and `SKILL.md` containing YAML `name` and `description`; registry discovery handles the rest. Only validated names and descriptions enter the base prompt. The model must explicitly call `load_skill`, then `read_skill_asset` for any needed listed asset. Ordinary media tools still enforce approval, ownership, funding and cancellation.

## Security and bounds

The API scans at Node startup, and the durable agent validates its registry before execution. Deploy/restart after changing bundles. Approved roots are application code, never model input. Each skill has at most 16 assets; files are UTF-8 Markdown, text or JSON, at most 16,000 bytes each and 64,000 bytes per serialized bundle. Up to 128 skills are supported. YAML rejects duplicate keys, custom tags, aliases, unknown fields and malformed metadata. Missing bodies, unsupported files, links, traversal, special files, excessive directory depth and oversized files fail validation. Assets are looked up from validated snapshots rather than opened using a model-provided path. The parser uses [yaml's documented strict parsing and alias limits](https://eemeli.org/yaml/).

## Durable versions

The first load saves a content-addressed SkillVersion containing the body and all bounded asset contents, plus a unique `(runId, name)` RunSkill reference. Each tool result records bundle and content hashes. Repeated loads reuse the same invocation and pinned bundle. A resumed loader restores PostgreSQL's version even when deployed files change or disappear; saved bundles are revalidated and their hash checked before use. Unloaded assets remain on that version until explicitly requested. These read-only tools cost 0M credits and never dispatch media jobs or request media credit holds. Previous turns retain visible tool cards but only skill receipt summaries re-enter ordinary conversation context.

Tool discovery, input validation and dispatch use the shared typed registry. Guidance output is an additive text result in the existing tool contract and renders in the generic tool card. Adding another skill requires no orchestration or UI branch. Mixed batches preserve result identities and positions, and independent media work continues through Trigger's batch child tasks.

## Migration, deployment and rollback

Migration `20261029043000_on_demand_skills` adds SkillVersion and RunSkill with foreign keys, a composite skill-name/version relationship, indexes and a unique per-run skill pin. It only expands the allowed tool names; existing histories, usage and media receipts are unchanged. Apply `pnpm db:deploy`, regenerate Prisma, export contracts, and ship matching API/worker/frontend. Trigger's additional-files extension bundles `agent-skills/**`; Next's output tracing includes those same files. No new secret or service is required.

New output shapes and tool names are additive, but older clients' strict validators may reject them. Deploy the updated readers before enabling loader execution; old media payloads remain valid. For rollback, disable new skill loads and drain active runs first. Keep the new tables and expanded tool-name constraint, and retain a reader capable of displaying existing guidance cards. Do not deploy an older worker over active pinned runs or drop historical guidance outputs. A destructive local rollback requires exporting RunSkill, SkillVersion and guidance invocation/message references, removing their references first, then dropping RunSkill before SkillVersion. Prefer a forward fix once skill history exists.

## Verification

Unit tests cover metadata-only discovery, valid YAML, malformed frontmatter, duplicate and unknown names, traversal, links, unsupported formats, file limits and bundle hashing. Isolated PostgreSQL tests exercise selective model loading, load-before-asset order, duplicate calls, cancellation, changed inputs, corrupted snapshots, durable versions after file changes/removal, cross-owner history denial and ordinary media dispatch. All 198 tests passed: 99 backend unit, 60 PostgreSQL integration and 39 frontend tests. Type checks, lint and production builds passed in both repositories. The migration was applied to application and isolated test databases, and Prisma reported no schema drift. After the history-summary type fix, the five focused skill integration tests passed again. The production Next trace and Trigger worker build both include all three bundles and guides.

Live acceptance on October 29, 2026 (Asia/Kolkata) is saved at `/chats/066bf331-3300-49b2-bc60-bf43e3cca005`:

- Run `c0e6ef9a-7fbe-488a-bf88-6b7e3005756e` / Trigger `run_06go8rr3l5j7bcknnk0o77jqa2` loaded only `precise-cropping`, explicitly read `guides/rectangles.md`, and returned the correct centered 320×240 crop coordinates (160,120) for a 640×480 source. Full browser reload restored both tool cards and the reply.
- Run `ca5acb7a-ee27-4ac8-bc4e-0cc627748c78` loaded `image-composition` and `video-assembly`, then the free router returned a busy error before asset reads and the final answer. Both completed skill results remained visible and durable. This verifies those bundle loads and failure preservation, not a completed image/video planning response.
- A subsequent plain-text request (`c73c8c3a-7691-47a1-80a3-f8a94a48f031`) also hit the free-route busy response and loaded no skills. Selective ordinary-turn behavior is covered by the deterministic tests; that live request did not complete an answer.

Readback verified each saved content hash against the text and each tool's version against its RunSkill pin, including reconstruction from an empty in-memory registry. None of these runs dispatched media or charged usage. Completed and failed runs released their admission holds; the account remained at 0.995M credits with 0M credits reserved. Changed/deleted-file resume and concurrent deduplication were exercised in PostgreSQL integration tests, not through a live worker crash.

## Remaining limits

The changes are local and have not been deployed. The free router can rate-limit or choose malformed calls; the app preserves a clear failed turn, partial results and refunds, with no paid fallback. Guidance cannot guarantee a model follows every instruction. New file formats require an explicit safe parser and bounded contract; arbitrary binary assets and execution of skill scripts are unsupported. The next milestone is resumable media uploads and asset persistence. Full reference fidelity, long-context summarization, a 1,000-concurrent-turn load test, hosted deployment and public API documentation remain outstanding.
