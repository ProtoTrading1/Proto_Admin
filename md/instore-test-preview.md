# Instore connected test preview

This is a **test-branch-only** setup. It must never be placed on the production
admin deployment and does not turn on customer discovery, basket, checkout or
publication.

## Required preview-only server variables

Set these only on a new Vercel **Preview** deployment (or a local Vercel dev
session), never in Production. The key is entered in the hosting provider and
is not stored in this repository.

```text
INSTORE_ADMIN_PREVIEW_ONLY=true
INSTORE_ADMIN_TEST_PROJECT_REF=zbxvcdkcarrgtmdhwmdm
STOCK_SUPABASE_URL=https://zbxvcdkcarrgtmdhwmdm.supabase.co
STOCK_SUPABASE_KEY=<test-branch-server-key>
INSTORE_ADMIN_PUBLISH_ENABLED=false
INSTORE_STOREFRONT_CONTRACT=
```

The existing `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` remain the admin
authentication project so owner sign-in continues to work. Do not set any
`VITE_STOCK_SUPABASE_*` variable for this workflow: its database key must be
server-only.

The API checks all of the following before it opens the Instore workflow:

1. `INSTORE_ADMIN_PREVIEW_ONLY` is explicitly true.
2. The runtime is not a Vercel production deployment.
3. `STOCK_SUPABASE_URL` has the exact hostname for the declared test project.
4. A server-only `STOCK_SUPABASE_KEY` exists.

If any check fails, `/api/instore-admin` returns a safe 503 before reading or
writing data.

## Safe test sequence

1. Apply the dedicated Instore migration to the isolated test branch only.
2. Create a fresh admin preview deployment with the variables above.
3. Sign in as an owner and stage three disposable images. Verify retry,
   archive, recycle and restore. Approval remains disabled.
4. Delete the sample rows and test storage objects, then keep the branch only
   if further integration testing is scheduled.

There is no production promotion path in this setup. A later storefront and
checkout implementation needs its own preview, contract tests and explicit
release approval.

