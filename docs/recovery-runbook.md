# Recovery Runbook (M1-01)

## Migrations are up-only

Journal migrations (`packages/runtime/src/db/migrations/`) never get a
DOWN. If a migration fails, restore the SQLite file from a pre-migration
backup — do not hand-edit `schema_migrations` or partially applied DDL.
A failed migration rolls back its transaction and records no version, so
the next open retries it from a clean state.

## Migration v2 delivery_key remainder

v2 backfills `wake_intents.delivery_key` and deterministically removes
NULL-era duplicates (keeps earliest `(created_at, id)` per
`(swarm_id, delivery_key)`, logged to stderr). Any rows it cannot merge
are left NULL and warned about — never deleted. Audit them with:

```sql
SELECT id, swarm_id, member_id, reason, created_at FROM wake_intents
WHERE delivery_key IS NULL ORDER BY created_at;
```

Duplicate-key check (empty post-v2):

```sql
SELECT swarm_id, delivery_key, COUNT(*) AS n FROM wake_intents
WHERE delivery_key IS NOT NULL GROUP BY swarm_id, delivery_key
HAVING n > 1;
```
