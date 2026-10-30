# Local Trigger.dev bootstrap

Organization: **Test**. Project: **Magica Trial**, on the Free plan.
Project reference: `proj_ihrvokfzqpzzdmqwyira`.

The existing `trigger.config.ts` reads `TRIGGER_PROJECT_REF` from the backend
`.env.local`. Tasks live in `trigger/`. The SDK and CLI remain pinned to 4.8.1.
No production deployment is part of this bootstrap.

## Start the worker

From the backend repository:

```bash
pnpm dlx trigger.dev@latest login --profile magica-work-trial
pnpm trigger:dev
```

The `trigger:dev` script selects the `magica-work-trial` CLI profile for this
work-account project. Skip login if that profile is already authenticated. Keep the terminal open and wait
for `Local worker ready`. Stop it with Ctrl+C; restart with `pnpm trigger:dev`.
Only one local worker for this project is needed.

CLI login and the project reference are sufficient for this test. No
`TRIGGER_SECRET_KEY`, OpenRouter key, or database is needed. Server-side dispatch
and the separate model connection test require their own configuration later;
see [agent service setup](agent-setup.md).

## Run the harmless test

Open the [Development Tasks page](https://cloud.trigger.dev/orgs/test-2de7/projects/magica-trial-detS/env/dev)
using the work account. Choose `trial-bootstrap-check`, open **Test**, use the
following payload, and press **Run test**. If a printed CLI shortcut says Not
found, use this Tasks page; also check that the browser matches the CLI account:

```json
{"message":"Hello from my first task"}
```

Expected output:

```json
{"ok":true,"message":"Hello from my first task"}
```

The task in `trigger/bootstrap-check.ts` validates its payload and returns it.
It performs no model calls, database writes, or external side effects. Confirm a
completed run in the Development dashboard and worker output; worker readiness
alone does not verify execution. Keep this task for local worker health checks.

The `agent-connection-check` task is a separate real OpenRouter probe and must
only be tested after its key is configured. The bootstrap task does not implement
the chat send route, agent loop, persistence, streaming, or recovery.

Reference: [Trigger.dev bootstrap skill](https://trigger.dev/SKILL.md).
