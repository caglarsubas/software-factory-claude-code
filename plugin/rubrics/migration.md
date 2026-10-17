# Migration rubric

Applies to the migration reviewer, on top of the review rubric. For each migration, check in this order:

1. **Existing data.** What happens to rows already there: a new non-null column needs a default or a backfill; a type change must convert every existing value.
2. **Destruction.** Dropping or renaming a table or column, or deleting rows, loses data unless the spec asks for it and the code no longer reads it.
3. **Reversibility.** A down migration exists and restores the schema, or the spec says the change is one-way.
4. **Ordering.** The code in the same change works against both the old and the new schema while the migration runs, or the spec allows downtime.
5. **Locks and size.** A rewrite or index build on a large table without the database's online option is called out.

Severity: data lost or made unreadable, a non-null column added without a default or backfill, or code that breaks against the schema the migration leaves is **blocking**. A missing down migration is **major** unless the spec says one-way.
