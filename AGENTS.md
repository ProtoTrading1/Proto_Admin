# Proto Admin Portal Agent Rules

This repository is the standalone Proto Trading admin portal. The customer-facing
portal is a separate repository; never implement storefront work here.

Read `CLAUDE.md` before making changes. It contains the architecture, authentication,
customer, fulfilment, and removed-feature constraints for this application.

## Mandatory change journal

Every change to code, configuration, dependencies, database migrations, automation,
or deployment behaviour must be recorded in `md/changes/YYYY-MM-DD.md` before the
task is complete.

- Append to the file for the actual date; preserve all existing entries.
- Include the time, summary, affected files or systems, verification, deployment
  status, and commit or PR reference when available.
- Record external Supabase and Vercel changes too.
- Never log secrets, credentials, tokens, or customer personal data.
- A journal-only documentation edit does not need another journal entry.

## Minimum verification

For application changes, run the most relevant tests plus `npm run lint` and
`npm run build`. Do not report a deployment as complete until the deployed commit
and production behaviour have been verified.
