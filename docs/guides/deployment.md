# Production deployment

Deploy the backend and frontend to their existing Vercel projects and the worker to the existing Magica Trial Trigger.dev project. Use only the free service plans. The local Docker database is development-only.

## Production environment

Keep `.env.local` for development. Store release settings in ignored `.env.release.local` with owner-only file permissions. Never commit or print secret values. The release file must contain the complete backend environment from `.env.example`, with these replacements:

| Setting | Production value |
| --- | --- |
| `DATABASE_URL` | Hosted PostgreSQL pooled URL with TLS (`sslmode=require` or stronger) |
| `DATABASE_URL_UNPOOLED` or `DIRECT_URL` | Same database's direct URL with TLS, used for migrations |
| `FRONTEND_ORIGIN` | `https://trial-magica-frontend.vercel.app` |
| `PUBLIC_API_BASE_URL`, `UPLOAD_PUBLIC_API_ORIGIN` | `https://trial-magica-backend.vercel.app` |
| `TRIGGER_SECRET_KEY` | Existing Magica Trial **Production** key (`tr_prod_…`) |
| `TRIGGER_PROJECT_REF` | Existing Magica Trial project reference |
| `OPENROUTER_MODEL` | `openrouter/free`, with no paid fallback |
| `TRANSLOADIT_PLAN` | `community` |
| `WEBHOOK_MASTER_KEY` | Stable, private 32-byte base64 signing master; identical in API and worker |

Copy the already verified service credentials for OpenRouter, the supplied Magica API, uploads, and private object storage into server-only Vercel and Trigger production settings. Keep Clerk keys on the existing Clerk instance so frontend sessions and backend verification agree. The frontend receives only its Clerk settings and `NEXT_PUBLIC_API_BASE_URL=https://trial-magica-backend.vercel.app`; it must never receive database, media, worker, storage, or webhook secrets.

Connect the free Neon resource to backend **Production** only. Preview deployments need a separate database, worker environment, and allowed frontend origin before they can serve chat traffic safely. Do not give previews production database access.

## Release order

For the rich-message release, follow the [reader-first exception](rich-messages-and-diagnostics.md#compatibility-and-rollback): frontend first, then backend API, then the Trigger worker. The new JSON variants require the compatible reader to remain installed during rollback.

1. Run `pnpm deploy:check .env.release.local`. This checks configuration only and never calls paid services. Run type checks, lint, unit tests, and the isolated local database integration suite.
2. Export the release environment into the migration process, then run `pnpm db:deploy` and `pnpm db:check`. Prisma prefers `DIRECT_URL`, then `DATABASE_URL_UNPOOLED`, then `DATABASE_URL`. Application queries continue using pooled `DATABASE_URL`.
3. Save production variables to Vercel and Trigger.dev. Preserve the same database, project reference, API origin, and webhook master across both. Do not import `.env.local` wholesale or copy Vercel CLI/OIDC tokens into either service.
4. Run `pnpm trigger:deploy` after the worker environment is configured. Verify every required task is registered and the webhook delivery schedule is active in Production.
5. Deploy the backend, then the frontend, from the reviewed release commits. Existing Vercel projects track `main`; branch pushes alone do not release Production. A CLI production deployment must be associated with the same reviewed source revision.
6. Verify sign-in, create/send/read, a reload during an active run, attachment completion, the required media tools, approval/cancellation, credits, and signed webhooks against the deployed URLs. Configuration checks and green builds alone do not verify these behaviors.
7. Regenerate the OpenAPI document using the deployed `PUBLIC_API_BASE_URL` before publishing Mintlify. Run `pnpm docs:check` with that same URL.

## Compatibility and rollback

The direct migration URL is optional, so existing local setups keep working. This configuration change adds no database schema migration. Apply all committed migrations in order; feature-specific migration and rollback notes are linked from the documentation index. Never run `migrate reset` or `db push` against the production database.

If a release fails, stop new work and restore the prior Vercel deployments and matching Trigger task version. Preserve persisted runs, attachments, credit entries, and webhook deliveries. Do not drop tables or rotate the webhook master as a rollback: those actions would destroy recovery or signature continuity. Keep compatible schema additions in place and reconcile active runs before resuming traffic.

## Fresh-database migration verification

Before release, set `DATABASE_MIGRATION_TEST_URL` to the local Docker PostgreSQL server on port 5433 and run `pnpm test:migrations`. The check creates a uniquely named disposable database, applies every migration in order, repeats deployment to check idempotency, verifies ownership foreign keys and the final index, and removes only that database. It never accepts a hosted database URL.

### Upload ownership migration repair

Uploads originally referenced `Chat(id, userId)` before the credit migration created its unique index. Two additive migrations preserve all historical checksums: an earlier prerequisite supplies a temporary unique index on fresh installations, and a final atomic migration rebinds foreign keys to the canonical index and removes the temporary one. Already-initialized databases skip both operations when the canonical index exists. The final schema and application contracts are unchanged; Prisma client regeneration is unnecessary.

For a database stopped at `20261029000000_uploads`, inspect its tables, constraints, and migration record first. PostgreSQL may retain statements before the failure. Apply the prerequisite SQL, then complete only the missing statements from the unchanged uploads migration. Verify all indexes, foreign keys, and checks before recording both migrations with `prisma migrate resolve --applied <name>`, then run `prisma migrate deploy`. Never mark incomplete SQL as applied or reset a database containing user data.

Rollback: these changes only restore constraints already required by the application; an application rollback can retain them. Do not drop the bridge index while foreign keys depend on it. If the final repair fails, its DO block rolls back atomically; fix the cause and use Prisma's failed-migration recovery before retrying. No rows are deleted or rewritten.
