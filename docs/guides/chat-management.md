# Chat search, favorites, and Trash

## Contracts and behavior

- `GET /api/app/v1/chats?view=all|favorites|trash&q=words&limit=20&cursor=...` searches owned titles and visible text blocks. `q` is trimmed and limited to 120 characters. Omitted filters retain the original list behavior.
- `PATCH /api/app/v1/chats/:id` with `{ "isFavorite": true }` sets a value instead of toggling, making duplicate submissions safe. The response is the chat DTO.
- `DELETE /api/app/v1/chats/:id` moves an owned inactive chat to Trash and returns `{ id, deletedAt }`. Repeating deletion returns the same receipt.
- `POST /api/app/v1/chats/:id/restore` restores that chat, retaining its messages, timestamps, favorite flag and media. Repeating restore is safe.

All chat responses add `isFavorite` and nullable `deletedAt`. Generated consumers default missing fields for compatibility with the earlier API. Existing request fields and original unfiltered cursors remain valid. Every read/mutation enforces Clerk ownership; foreign and missing IDs return the same 404.

Search uses PostgreSQL full-text word matching with the `simple` configuration and `websearch_to_tsquery` (case insensitive, quoted phrases and OR supported). It is not arbitrary substring matching or semantic search. GIN expression indexes cover titles and visible text blocks; tool arguments, identifiers, and attachment metadata are excluded. User search text is a bound SQL parameter. Both branches scope results to the owner, deduplicate matching conversations, then return at most `limit + 1` rows. No application-side history scan or total count is performed. Index design follows [PostgreSQL text-search guidance](https://www.postgresql.org/docs/current/textsearch-tables.html).

All views preserve immutable `(createdAt, id)` descending order. Favorite changes do not reorder the All chats view. Search and view filters are hashed into cursor scope; reusing a cursor with different filters is rejected. The frontend starts a fresh query when filters change and clears related cached reads after deletion.

## Safe deletion and concurrency

Trash is recoverable deletion, not permanent erasure. Trashed chats disappear from active lists and their detail/message/run endpoints return 404. They cannot accept new turns or uploads until restored. Files remain owned and available through the media library; financial history and provider receipts are retained. There is no automatic retention purge in this milestone.

Deletion, turn admission, and upload admission serialize on the same chat row. The delete transaction rejects active runs, unfinished/unknown tool invocations, and active uploads with `409 CHAT_BUSY`. Finish or cancel known work before deleting; unknown provider submissions require reconciliation. Recovery tasks may continue settling already-terminal work. Favorites and restore also lock the owned row. No database lock spans external calls.

The UI confirms moving a chat to Trash, supports cancellation with focus restoration, shows server-safe conflict errors, and provides Restore in the Trash filter. Requests are cancelled on session unmount; late results cannot navigate a different signed-in user. Network retries use explicit idempotent mutations, not automatic destructive replays.

## Migration and rollback

Apply `20261030010000_chat_management` with `pnpm db:deploy`, then `pnpm db:generate`, before starting the API and workers. It adds `Chat.isFavorite` (false) and nullable `Chat.deletedAt`, list/admission indexes, an immutable `chat_message_text(jsonb)` helper, and GIN expression indexes. Existing rows remain active and not favorited. No application data is deleted or copied into a second database. The custom expression indexes/function are intentionally managed in SQL rather than unsupported Prisma schema expressions.

The local trial uses ordinary index creation. On a populated hosted deployment, review index-build duration and lock requirements; schedule a maintenance window or split index creation into a reviewed concurrent migration. Do not run a development database reset on retained user data.

Rollback application code only to a reader that respects `deletedAt`; an older reader would expose chats in Trash again. Stop admission/workers before any incompatible rollback. Keep the additive columns, function, indexes, messages, and media. If a destructive schema rollback is unavoidable, export Trash/favorite state and obtain an explicit retention decision first, then drop dependent GIN indexes before dropping `chat_message_text`. Prefer a forward fix. No destructive rollback was exercised against the application database.

## Verification

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `DATABASE_TEST_URL=<isolated-local-test-url> pnpm test:db`. The management suite checks title/message search, excluded metadata, owner isolation, filtered/tied pagination, cursor scope, idempotent favorite/delete/restore, retained history, denied run/upload admission, unresolved tools, delete/send and delete/upload races, REST validation, auth, and CORS.

Frontend tests exercise search submission/reset, favorite writes, delete confirmation/cancellation, Trash/restore, busy errors, and a delayed response after sign-out. Live verification uses a dedicated trial chat and existing message-search fixtures; no existing conversation is permanently deleted. Hosted rollout and representative search load testing remain separate acceptance gates.

### Local browser acceptance — October 30, 2026

The signed-in local app created `Chat management verification` (`142bcf0d-5f9b-49bb-8843-d9e2581b6402`). Adding it to Favorites persisted across reload. Searching `management` found title/message matches; searching `flower` found the existing Live video merge conversation from its message text. The real list/search, PATCH favorite, DELETE, and POST restore endpoints returned success through the browser.

Cancelling deletion left the chat intact. Confirming deletion removed it from the active list, navigated to `/chats`, and exposed it only in Trash. Opening its direct URL returned Chat not found, with 404 detail/message responses. Restore retained the favorite and reopened the conversation without a reload. That last case initially exposed a cached-message-error bug; a failing UI regression and a live repeat now pass after invalidating message/run queries on restore. The verification chat remains restored. No existing chat, file, or credit history was permanently deleted. Credit balance remained 0.995M credits; these management operations dispatched no model/media work.

Both local databases applied the migration; generated contracts, type checks, lint, and production builds passed. Backend verification passed 113 unit and 88 database tests. The frontend suite includes 52 tests. Concurrency/ownership cases were exercised in the isolated database tests, not by switching real user accounts or issuing a large live load test. The local Trigger worker started with the new admission code and completed its recovery task. No hosted deployment or Git publication was performed.
