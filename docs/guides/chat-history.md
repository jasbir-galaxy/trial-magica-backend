# Chat history API and database rollout

This is the trial backend's PostgreSQL chat store. A User links one verified Clerk
user ID to local ownership. A Chat belongs to one User; a Message belongs to one
Chat. No passwords or copies of Clerk profiles are stored. The existing `/me`
contract is unchanged, and reading an empty chat list does not create a User.

## Endpoints

All endpoints require a Clerk session token in `Authorization: Bearer ...`.
Owner IDs come exclusively from verified claims. Foreign and missing chats both
return `404 NOT_FOUND`. Every response uses `Cache-Control: no-store` and the
existing origin policy. Each route supports unauthenticated OPTIONS preflight.

| Method | Path | Result |
| --- | --- | --- |
| POST | `/api/app/v1/chats` | Chat DTO; 201 for creation, 200 for a retry |
| GET | `/api/app/v1/chats` | Paginated chats owned by the signed-in user |
| GET | `/api/app/v1/chats/:chatId` | One owned Chat DTO |
| GET | `/api/app/v1/chats/:chatId/messages` | Paginated messages for an owned chat |

POST accepts JSON such as `{ "title": "Project notes", "requestId": "<UUID>" }`.
Both fields are optional; `{}` creates a chat titled `New chat`. Titles are trimmed
and limited to 120 characters. The request body is capped at 4096 bytes, measured
from the stream rather than trusting Content-Length. Unknown creation fields are
rejected. Client-provided user IDs never control ownership.

Generate a requestId once per new-chat action and reuse it for transport retries.
The same user/requestId/title returns the original chat even under simultaneous
requests. Reusing that ID with different details returns 409. Different users can
use the same requestId independently. Omitting it creates a new chat each time.
The returned Location header identifies the chat detail route.

A Chat DTO contains `id`, `title`, `createdAt`, and `updatedAt`. Timestamps are UTC
ISO strings; IDs are UUIDs. No internal ownership fields are returned.

Both lists accept `limit` (default 20, range 1–100) and optional opaque `cursor`.
They return `{ items, nextCursor, hasMore }`. Chats sort by creation time and ID,
newest first. Messages default to oldest first for compatibility; `order=desc` returns newest messages first with older-message cursors. The next page
starts strictly beyond the previous boundary; timestamp ties do not duplicate or
skip rows. Cursors are versioned positions, not access credentials. Every query
still filters by the verified owner. Invalid or wrong-message-chat cursors return
400. Pagination is a live view, not a frozen snapshot. Lists fetch at most
`limit + 1` records and never scan/count the whole history for a total.

Message DTOs contain `id`, `chatId`, `role`, `status`, `content`, `createdAt`, and
`updatedAt`. Roles are `user`, `assistant`, and `system`. Statuses are `pending`,
`streaming`, `completed`, `failed`, and `cancelled`. Content is an array of up to
100 validated blocks, currently `{ type: "text", text: "..." }`; each text is
1–32000 characters. Empty arrays support not-yet-populated messages. Future
message writers must validate `MessageContentSchema` before persistence. Output
validation also rejects corrupt stored content with a safe 500 response.

This milestone does not add message submission or AI generation. Newly created
chats therefore have empty message histories. No frontend changes are included.
The shared Zod contracts live in `src/contracts/chats.ts`; export them with the
existing `scripts/export-contracts.mjs` when adding the frontend consumer.

Request validation failures use 400, oversized JSON uses 413, and unsupported
content types use 415. Auth and API errors retain the existing
`{ error, message, code, traceId }` shape; database and SDK details stay private.

## Migration and compatibility

Migration `20261028105655_init_chat_history` adds User, Chat, and Message tables,
two enums, unique user and retry keys, foreign keys, and pagination indexes.
It does not alter existing tables or authentication. No backfill is required.
Foreign keys restrict deletion so accidental parent removal cannot erase history.

Local development: `pnpm db:migrate` and `pnpm db:generate`.
Hosted release: back up the target database, run `pnpm db:deploy`, then deploy
this backend. Vercel needs its own hosted DATABASE_URL and cannot use laptop
PostgreSQL. Client generation runs during installation/build; migrations do not.

To roll back the application, redeploy the previous backend and retain these
additive tables. Old `/me` and health routes do not depend on them. Do not drop
tables after chats have been created: that would destroy user-owned history.
Any later schema rollback requires a reviewed forward migration and data export
or backup. Do not reset databases or manually edit the migration ledger.

## Verification

Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`.
For database integration tests, create the dedicated local database once:

```bash
docker compose exec -T postgres createdb -U magica magica_trial_test
export DATABASE_TEST_URL='postgresql://magica:magica_local_only@127.0.0.1:5433/magica_trial_test?schema=public'
DATABASE_URL="$DATABASE_TEST_URL" pnpm db:deploy
pnpm test:db
```

The integration config refuses any other database name, non-loopback host, or
port. The suite uses real migrated PostgreSQL and real route handlers, with only
the Clerk SDK verification result mocked. Cleanup deletes only generated fixture
users and their chats/messages. Coverage includes concurrent retries, conflicting
retries, cross-user access, tied-timestamp pagination, structured stored content,
empty states, input errors, preflight, and sanitized database failures.
A passing integration suite does not by itself prove a deployed Clerk/browser
flow. Verify new endpoints with a real signed-in client after deploying them.
