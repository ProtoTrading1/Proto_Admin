---
name: proto-safe-main-release
description: Protects Proto Admin production from stale-branch overwrites. Use whenever changing, previewing, publishing, merging, deploying, or repairing admin.proto.co.za, Proto_Admin, protoportal-admin, or an admin backend feature that must preserve Daniel's latest work.
---

# Proto Safe Main Release

Keep the current production branch as the protected baseline. A feature is not permanent until it is merged into that branch.

## Non-negotiable rules

- Never promote, alias, or deploy a feature branch directly to `admin.proto.co.za`.
- Never treat a successful preview as permission to change production.
- Never reuse a long-lived branch as the base for a new release.
- Never replace the current application with an older snapshot, partial build, or preview export.
- Preserve Daniel's latest merged work and all unrelated routes, navigation, data flows, and integrations.
- Production may change only through the repository's verified production branch after the scoped pull request is merged.

## Establish the live baseline

Before editing:

1. Inspect `admin.proto.co.za` and record its Vercel project, deployment ID, Git repository, branch, and full commit SHA.
2. Verify the repository default branch and the branch configured for production. Do not assume either is `main`.
3. Fetch the remote production branch and confirm the live commit is present in it. Stop on an ownership, repository, branch, or commit mismatch.
4. Capture the signed-out page, affected workflow, current navigation, original deep link, and at least one unrelated working section. If authentication blocks the affected workflow, record the signed-in verification as a required handoff.

## Start from current production source

1. Use a clean clone or clean worktree.
2. Create a new scoped branch from the latest remote production branch.
3. Record the base SHA before making changes.
4. If restoring an older commit, cherry-pick only that commit onto the fresh branch. Do not deploy its original branch.
5. Resolve conflicts by preserving current production behavior and applying only the requested feature. Never choose an entire old file over a current file without reviewing the full diff.

## Additive-change gate

Compare the completed branch against the remote production branch, not against an older feature branch.

Block the release when the diff contains any unexplained:

- deleted or renamed routes;
- removed navigation items, imports, feature flags, or API handlers;
- broad file replacements;
- environment or hosting changes;
- database migrations or data writes;
- changes outside the requested feature and its tests.

Add a focused regression test for the requested behavior. Preserve unrelated user and collaborator changes.

## Verification gate

Before publishing the branch:

1. Run the focused regression test.
2. Run lint, the relevant full suite, and the production build.
3. Inspect the final diff and confirm the branch still descends from the latest remote production branch. If the remote advanced, rebase or recreate the branch and repeat verification.
4. Create a Vercel preview from the feature branch only.
5. Verify the requested change, the captured navigation, the original deep link after refresh, authentication boundaries, and one unrelated workflow.
6. Report pre-existing or unrelated failures separately. Do not hide them or repair them inside the scoped change.

## Publication and release

1. Push the scoped branch only after the user authorizes code publication.
2. Open a pull request into the verified production branch.
3. Record the PR, base branch/SHA, head branch/SHA, preview URL, test results, build result, and any signed-in check still required.
4. Do not manually point `admin.proto.co.za` at the preview deployment.
5. Merge only with explicit merge authority and only after required checks and review pass.
6. Allow the normal production-branch deployment to release the merged code.
7. Verify that the live Vercel deployment identifies the production branch and contains the merged commit. Recheck the requested feature and preserved baseline on the custom domain.

## Disappearing-feature diagnosis

When a feature disappears after another release, first check whether its commit was merged into the production branch. If it exists only on a feature branch or manually promoted deployment, explain that the production alias changed snapshots; do not describe this as Git overwriting branches. Restore the feature by applying its scoped commit to a fresh branch from current production source and merging it normally.

## Required handoff

Report:

- repository and production branch;
- protected base SHA and feature SHA;
- files intentionally changed;
- focused, full-suite, lint, and build results;
- preview and PR links;
- what was preserved;
- whether production changed;
- the exact remaining review, merge, or signed-in verification step.
