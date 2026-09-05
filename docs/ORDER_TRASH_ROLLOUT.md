# Recoverable order trash — release gate

Order deletion is intentionally fail-closed in this branch. The previous permanent-delete and delete-all paths are removed.

## Required approval and rollout order

1. Review `migrations/056_recoverable_order_trash.sql` against a disposable copy of the current `orders` schema.
2. Explicitly approve and apply migration 056.
3. Verify `trash_admin_order` removes one synthetic order and writes a complete JSON snapshot in the same transaction.
4. Verify `restore_admin_order` recreates that synthetic order exactly once.
5. Set `ORDER_TRASH_ENABLED=true` in a Vercel preview only.
6. Test moving and restoring a synthetic preview order, then obtain separate production approval.

Orders with linked notification or delivery records are deliberately ineligible
for trash. This preserves the audit trail and prevents restored queue rows from
being replayed. Reconcile those records under a separate approved procedure;
do not remove them merely to make an order trashable.

Until the migration and flag are both present, the API returns `409` instead of permanently deleting an order. “Delete all orders” is no longer supported.

## Rollback

Set `ORDER_TRASH_ENABLED=false`. This immediately disables the trash mutation endpoints. NOTE: the default is now ON (056 and 057 are applied in production), so *unsetting* the variable no longer disables anything — it must be set to `false` explicitly. Do not drop `admin_order_trash` while it contains unrestored records; export and reconcile them before any schema rollback.
