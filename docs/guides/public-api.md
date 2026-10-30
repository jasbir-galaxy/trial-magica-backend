# Public API rollout

Public routes at `/api/v1` use scoped, expiring API keys. Clerk session routes at
`/api/app/v1/api-keys` create/list/revoke keys. A random 256-bit key is shown once;
PostgreSQL stores only its SHA-256 digest and a display prefix. Lost create
responses require revoking the listed key and creating a new one. Revocation
blocks future admission; accepted work remains owned by the account.

Apply `20261030030000_public_api`, regenerate Prisma, deploy the worker, then the
API and generated client contracts. Existing runs default to `kind=agent`.
Direct tool runs use the same run/message admission, approval, credits, child
tasks and recovery. They persist a pinned tool invocation before dispatch and do
not call an LLM. Retry IDs compare the pinned tool input hash and execution kind.

Rollback: disable public writes, drain/cancel direct-tool runs, then revert the
routes and worker together. Keep historical run/tool rows and additive readers.
After exporting API-key metadata and removing all dependent code, the schema
rollback is `DROP TABLE "PublicApiKey"; ALTER TABLE "AgentRun" DROP COLUMN "kind";
DROP TYPE "RunKind";`. Keys must be recreated after this destructive rollback.
Prefer retaining the additive schema and rolling forward. Never roll back to an
old worker while queued direct-tool runs remain: it would interpret them as chat.

The async chat-completions endpoint accepts one new user message, not arbitrary
client-authored system/tool history and not OpenAI streaming compatibility.
PostgreSQL is the conversation source of truth. Public clients poll the returned
run location or subscribe to signed lifecycle webhooks. All paid model choices
are rejected; the only LLM route is `openrouter/free`.

## Documentation and deployment

The signed-in frontend exposes credential and subscription management at
`/chats/integrations`. One-time secrets stay in mounted component state, outside
query/mutation caches and browser storage. Navigation cancels pending requests;
an uncertain creation must be resolved from the list before creating another.

Run `pnpm docs:generate` after contract changes and `pnpm docs:check` to detect
stale output. The specification is served at `/api/v1/openapi.json`. For a deployed
backend, set `PUBLIC_API_BASE_URL` to its canonical HTTPS origin. The checked-in
Mintlify specification targets local port 3001; update its server URL through
the generator when preparing the hosted docs.

From `docs/site`, use `pnpm dlx mint@4.2.1178 validate`,
`pnpm dlx mint@4.2.1178 broken-links`, and
`pnpm dlx mint@4.2.1178 dev --port 3333 --no-open` for local review.
The site includes authentication, async run behavior, tool discovery, errors and
signature verification, with an interactive endpoint reference.

Local validation includes all unit/UI/database suites and both production builds.
Real public free-text and direct Crop Image runs, idempotent retries, and signed
HTTPS deliveries through the background queue were exercised. Test keys and
subscriptions were revoked or disabled afterward.

Release work remains: apply migrations to the hosted PostgreSQL database; set
the stable webhook master in both deployed processes; deploy tasks and both apps;
connect and publish the Mintlify site; verify authenticated flows against the
deployed URLs; and load-test the target concurrency within service quotas.
The local checks do not establish 1,000-turn production capacity.
