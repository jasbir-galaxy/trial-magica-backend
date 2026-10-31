# Magica Trial backend

REST API and durable agent execution for the Magica agent-chat work trial. The
[frontend repository](https://github.com/jasbir-galaxy/trial-magica-frontend) is a
separate Next.js application. This backend uses strict TypeScript, PostgreSQL and
Prisma, Clerk, Trigger.dev, Zod, OpenRouter Free, the supplied Magica media APIs,
and signed uploads to private S3-compatible storage.

## Setup

Use Node.js 24 and the pinned pnpm version. Copy `.env.example` to `.env.local`,
add the trial credentials, start Docker Desktop, then run:

```bash
pnpm install
docker compose up -d --wait
pnpm db:deploy
pnpm db:check
pnpm agent:check
pnpm dev --port 3001
```

In a second terminal, run `pnpm trigger:dev`. The frontend runs on port 3000.
Use the same Clerk application in both repositories. Never commit credentials.
See the [documentation index](docs/README.md) for service setup and migrations,
and the [production deployment guide](docs/guides/deployment.md) before deploying.

## Architecture and decisions

Authenticated routes validate ownership and Zod contracts, persist the message and
run transactionally, then dispatch durable work. PostgreSQL owns recovery state;
Trigger realtime metadata and text streams are transports. A partial unique index
enforces one active run per chat; dispatch, approvals, tool receipts, and charges
have separate idempotency boundaries. Cursor pagination bounds history reads.

A provider-neutral loop uses only `openrouter/free`. One tool registry supplies
discovery, validation, estimates, execution, and results. Crop Image, GPT Image 2,
and Merge Videos call the supplied API. Skill metadata enters the base prompt;
typed loaders fetch approved, versioned guidance on demand. Generated frontend
contracts keep the two repositories aligned without a deployment-time sibling dependency.

Tool execution uses child tasks and durable approval waits. Uploaded and generated
assets remain attached to persisted results. An outbox emits signed lifecycle
webhooks with bounded retries. The public REST API and Mintlify OpenAPI document
derive from the same runtime schemas.

Rich replies persist measured activity, provider reasoning, citations and model usage.
See [rich messages and diagnostics](docs/guides/rich-messages-and-diagnostics.md)
for limits, trace correlation, verification and reader-first deployment.

## Validation and remaining work

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm docs:check`, and `pnpm build`.
Run `pnpm test:db` only against the dedicated test database described in the
[history guide](docs/guides/chat-history.md). Real local provider acceptance is
recorded in the [media guide](docs/guides/media-tools.md); fixtures alone do not
establish provider success.

Before submission, repeat acceptance against the hosted deployment, publish the
Mintlify site, and record the demo. The 1,000-concurrent-turn load target has not
been measured. Longer-context compaction and stronger free-model intent fidelity
remain improvements; 1,000-message UI virtualization has been exercised locally.
Provider submissions with ambiguous receipts are preserved for reconciliation
instead of being retried blindly and risking duplicate charges.

## Browser connection

Set `FRONTEND_ORIGIN=http://localhost:3000` in `.env.local` for local development.
In Vercel Production, use `https://trial-magica-frontend.vercel.app` and redeploy.
Origins must have no trailing slash. CORS is not authentication.
`GET /api/health` supports configured-origin browser requests and originless health probes.
`OPTIONS /api/health` permits GET with Authorization and Content-Type headers.

The health contract is owned by `src/contracts/health.ts`. Export changes with:
`node scripts/export-contracts.mjs "../Magica Frontend/src/generated"`.
Commit the generated frontend file with its consuming change. Deployments do not need sibling checkouts.
Run `pnpm test`, `pnpm typecheck`, and `pnpm lint` before publishing.

## Session authentication

`GET /api/app/v1/me` accepts a Clerk session token in `Authorization: Bearer ...`.
It returns `{ "userId": "user_..." }` from verified session claims only. Clerk owns authentication; PostgreSQL stores the application user reference and owned resources, never passwords.
Missing or rejected sessions return 401; unavailable verification returns 503. Responses are not cached.
OPTIONS preflight is unauthenticated, and auth error responses retain CORS headers.

Use the same Clerk application and instance as the frontend. In your host terminal:

```bash
npx -y clerk@latest link --app app_3LHpn5TyCbBEbkM3vrRXHeLfgSf
npx -y clerk@latest env pull
```

The server requires `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` (or `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`), and `FRONTEND_ORIGIN`.
Do not commit actual keys. No Clerk init or UI provider is needed in this API-only project.
For deployed testing, configure matching instance keys in each Vercel project and redeploy; Vercel's Production environment does not itself select a Clerk instance.
Validate locally at the signed-in frontend's `/connection` page, then sign out and confirm no identity remains.

## Local PostgreSQL with Docker

Start Docker Desktop, then run from this repository:

```bash
docker compose up -d --wait
docker compose ps
```

The trial database listens only on `127.0.0.1:5433`, separately from other projects on port 5432.
The Compose project has its own `postgres_data` named volume. PostgreSQL 18 uses a versioned data directory under `/var/lib/postgresql`.

When configuring Prisma, add this development-only URL to the backend `.env.local`:

```dotenv
DATABASE_URL=postgresql://magica:magica_local_only@127.0.0.1:5433/magica_trial?schema=public
```

These are intentionally local-only credentials. Vercel requires a hosted database URL; it cannot connect to this laptop.
Do not overwrite the other entries in `.env.local`.

Verify SQL access:

```bash
docker compose exec -e PGPASSWORD=magica_local_only postgres psql -h 127.0.0.1 -U magica -d magica_trial -c 'SELECT current_database(), current_user;'
```

Useful commands:

```bash
docker compose logs --tail 50 postgres
docker compose stop
docker compose start --wait
docker compose down
```

`stop` and `down` preserve the named volume. Do not use `down --volumes` unless you intend to permanently erase this trial database.
Changing POSTGRES_USER, POSTGRES_PASSWORD, or POSTGRES_DB does not update an already initialized volume; change existing roles/databases with SQL instead.
## Prisma connection

Prisma ORM 7 uses the PostgreSQL driver adapter. Prisma CLI commands and the
connection check load `.env.local` using Next.js's environment loader. Existing
process environment variables take precedence; deployed hosts must provide their
own `DATABASE_URL`.

After installing dependencies with `pnpm install`, run:

```bash
pnpm db:validate
pnpm db:generate
pnpm db:check
```

`db:check` runs a real SQL query through the same Prisma client available to server
code via `src/db/client.ts`. It reports the database and user, without credentials.
The client is generated during installation and builds, and is excluded from Git.

The Prisma schema now includes users, chats, and messages, with an additive
migration and authenticated chat creation/history endpoints. Existing `/me`
authentication remains independent of database availability. See the
[chat history guide](docs/guides/chat-history.md) for API contracts, rollout and
rollback notes, and isolated database integration tests. All maintained guides
are listed in [docs/README.md](docs/README.md).

For subsequent schema changes, use `pnpm db:migrate --name <change>` locally and
commit the generated SQL migration. Run `pnpm db:deploy` against a hosted database
as an explicit release step, not during every build. Review migrations and back up
hosted data before applying them. Never point development migration commands at a
production database.

Setup reference: [Prisma PostgreSQL documentation](https://www.prisma.io/docs/v7/prisma-orm/add-to-existing-project/postgresql).

## Agent service setup

Run `pnpm agent:check` to check the backend configuration without printing keys.
Follow the [agent setup guide](docs/guides/agent-setup.md) to configure the free
model route and verify a real background worker. The first durable text-turn path
is implemented; see [durable text turns](docs/guides/agent-turns.md) for API behavior,
recovery, migration notes, known limits, and local verification. Start the API on
port 3001 and keep `pnpm trigger:dev` running alongside the frontend on port 3000.

## Media tools

The typed OpenRouter loop supports Crop Image, GPT Image 2 text/edit, and Merge Videos through durable Trigger.dev child tasks. Add the supplied server-only Magica key and base URL before testing real media conversations. See [configuration, recovery, migration notes, and acceptance checks](docs/guides/media-tools.md).

## Credits and approvals

New media tasks show their exact settings and estimated price before execution. Application credits use refundable admission, reservations, idempotent actual-usage settlement and cursor-paginated history. Approvals survive reloads and pause durable workers while waiting. See [credits and media approvals](docs/guides/credits-and-approvals.md) for configuration, migration/rollback notes, live verification and remaining limits.

## On-demand skills

Three application guidance bundles cover image composition, precise cropping and video assembly. The agent loads relevant guidance through typed tools, pins content-addressed versions in PostgreSQL, and displays saved results in existing tool cards. See [on-demand application skills](docs/guides/on-demand-skills.md) for authoring, security limits, migration/rollback and live acceptance.

## Chat management

Search owned chat titles and message text, manage favorites, and move inactive chats to recoverable Trash. See [API behavior, concurrency, migration and rollback notes](docs/guides/chat-management.md).

## Public API and webhooks

The authenticated settings page at `/chats/integrations` manages scoped API keys and signed webhook subscriptions. Public endpoints support durable conversations, direct media tools, approvals, run status and cursor-paginated history. See [API rollout and documentation](docs/guides/public-api.md) and [webhook operations](docs/guides/webhooks.md). Mintlify source lives in `docs/site`; generate its contracts with `pnpm docs:generate`.
