# Agent service setup

To verify Trigger.dev by itself, start with the [local bootstrap guide](trigger-bootstrap.md).
That harmless task needs CLI login only; the keys below are needed for the later model integration.

This is the next prerequisite after Clerk sign-in and PostgreSQL chat history.
The connection-check task verifies a real Trigger.dev worker calling the real
OpenRouter Free route. It is an operator check, not a chat implementation.

## 1. OpenRouter

Sign in to [OpenRouter](https://openrouter.ai/settings/keys) with your own trial
account and create a key. Add it to the backend `.env.local` as
`OPENROUTER_API_KEY`. Keep secrets out of chat, Git, and frontend variables.
There is no need to buy model credits for this trial.

The only supported requested model is `openrouter/free`. Leave `OPENROUTER_MODEL`
unset or set it to that exact value. Configuration rejects other models; the
probe constructs a request without a model-fallback array or paid plugins.
The actual routed model is recorded separately in its output. Free availability
and rate limits vary; a failed probe must be retried deliberately, never routed
to a paid model. See the [official free-router guide](https://openrouter.ai/docs/guides/routing/routers/free-router).

## 2. Trigger.dev

Use the existing **Magica Trial** project in the **Test** organization. The
backend is configured with project reference `proj_ihrvokfzqpzzdmqwyira` and uses
the `magica-work-trial` CLI profile. In this same project's Development
environment API Keys page, create a named key with Trigger only access and add it as
`TRIGGER_SECRET_KEY`. The key is for server-side dispatch; CLI login is separate.

Add the following values to the existing backend `.env.local` without replacing
the Clerk, database, or frontend-origin entries:

```dotenv
OPENROUTER_API_KEY=your_key
TRIGGER_SECRET_KEY=your_development_environment_key
TRIGGER_PROJECT_REF=proj_yourproject
```

The `your_*` values above are instructions, not usable credentials. Do not put
these keys in `NEXT_PUBLIC_*` variables. `.env.local` is ignored by Git.

From the backend directory, run:

```bash
pnpm agent:check
pnpm dlx trigger.dev@latest login --profile magica-work-trial
pnpm trigger:dev
```

Complete browser login/authorization yourself. Keep the worker terminal open.
`agent:check` validates presence and shape only; it does not verify credentials.
`trigger:dev` loads `.env.local` for the local worker. In the Development
dashboard, test `agent-connection-check` with payload `{}`. A successful run
returns `requestedModel`, `actualModel`, `promptTokens`, and `completionTokens`.
The check sends a fixed prompt only; it never reads existing chat messages.
Tokens may be `null` when the provider omits usage. The probe allows up to
1,024 completion tokens because free routing can choose a reasoning model;
reasoning and visible output can share the same token budget. A truncated
response still fails the check. See [reasoning token budgets](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens). Errors are sanitized, timeout
is bounded, cancellation aborts the request, and automatic retries are disabled.

Official references: [manual setup](https://trigger.dev/docs/manual-setup) and
[local worker command](https://trigger.dev/docs/cli-dev).

## 3. Durable chat turns

The first text-turn slice is implemented. Follow [durable text turns](agent-turns.md) for migration, API, recovery, and verification details. The composer sends an authenticated request; PostgreSQL stores the message pair and run, Trigger.dev executes OpenRouter Free, and realtime plus REST readback update the same assistant message.

The typed registry, provider-neutral tool loop and three Magica adapters are implemented; see [media tool configuration and live acceptance](media-tools.md). Next milestones are on-demand skills, uploads, approvals, credit admission/balances, full reference UI fidelity, and the remaining submission requirements. A production deployment also needs hosted PostgreSQL and worker environment variables; a cloud worker cannot reach this laptop’s loopback database.
