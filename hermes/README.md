# Proto Codex analytics worker

This worker is deliberately separate from the website runtime. It claims one
sanitized aggregate job, runs Codex CLI in a temporary read-only workspace,
and returns a bounded JSON report. It cannot write products, prices, stock,
orders, customers, deployments, or SQL.

## Required environment

Create `/etc/proto-codex-analytics.env` as `root:root` with mode `0600`:

```text
PROTO_ADMIN_URL=https://the-explicit-approved-admin-host
PROTO_ADMIN_ALLOWED_HOST=the-explicit-approved-admin-host
CODEX_ANALYTICS_WORKER_SECRET=a-long-random-worker-only-secret
CODEX_BIN=/opt/proto-analytics/codex-cli/node_modules/.bin/codex
CODEX_REPORT_SCHEMA=/opt/proto-analytics/worker/analytics-report.schema.json
CODEX_WORKER_ID=hermes-analytics-1
CODEX_ANALYTICS_MODEL=gpt-5.6-luna
```

For a protected Vercel preview only, add
`VERCEL_AUTOMATION_BYPASS_SECRET`. Never place a Supabase service key, admin
dashboard key, OpenAI API key, or customer data in this file.

The worker refuses to start without an explicit HTTPS origin and does not
follow redirects while carrying its worker secret. Codex runs with shell,
unified execution, web search, and subagents disabled; the model receives only
bounded numbers and generated catalogue references.

## Safe activation order

1. Deploy the matching Admin API and apply the reviewed queue migration to the
   same approved environment.
2. Install the worker, schema, service, and timer files.
3. Run `systemd-analyze verify` against the service and timer.
4. Confirm `/etc/proto-codex-analytics.env` is owned by root and mode `0600`.
5. Run the service once manually and inspect its journal.
6. Confirm the report in Admin contains aggregate figures only.
7. Enable the timer only after the manual run succeeds.

For preview testing, run the service once manually and leave the timer disabled.
Changing `PROTO_ADMIN_URL` is the only supported way to choose an environment;
the worker never defaults to production.

## Rollback

Disable and stop `proto-codex-analytics.timer`, remove the worker secret from
the Admin environment, and leave queued records inert. The storefront and
Admin dashboard continue operating without this worker.
