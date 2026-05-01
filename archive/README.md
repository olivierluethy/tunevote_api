# archive/

These files are **historical phpMyAdmin dumps**. They are kept here for
forensic reference only and are **not authoritative**.

| File | What it is |
|------|------------|
| `prod.sql` | phpMyAdmin dump of the production database, generated 2025-11-30 22:00. |
| `daddy.sql` | phpMyAdmin dump from a different environment, generated 2025-11-30 21:46. |

## Do not use these to reset or reseed any database

The single source of truth for the TuneVote schema is `init.sql` at the repo
root, applied via the Knex migrations in `migrations/`. Any drift between the
canonical schema and a live database must be resolved via a new migration —
not by hand-editing tables to match these dumps.

These dumps disagreed with each other and with `init.sql` in many places
(column types, missing tables, divergent ENUM values). Trusting them led to
the schema-drift bug class that Phase 1 of the database remediation work was
created to eliminate.

## When to delete

Once the production database has been successfully reconciled against
`init.sql` (verified via `npm run verify-schema` returning OK), and the team
is confident the historical context they provide is no longer needed, this
folder can be removed entirely.
