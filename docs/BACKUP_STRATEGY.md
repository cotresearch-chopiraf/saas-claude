# Database Backup & Recovery Strategy

This document exists because a red-team audit of this repository confirmed there was no documented backup strategy — application code has never had any backup logic in it, and it should not: backup/restore for this system's data belongs to whatever manages the production Postgres instance, not to this codebase. This document is the required production runbook that closes that gap. It does not assume any specific hosting provider, because none has been chosen yet — it states the requirements a production deployment must satisfy, and the concrete commands to satisfy them on plain, self-managed Postgres, since that is the one case this repository can guarantee works everywhere.

## What must be backed up

The entire Postgres database backing `DATABASE_URL`. Every table in `server/src/db/schema.ts` — companies, users, projects, budget items, expenses, tasks, change orders, daily logs, quotes/invoices and their line items, invites, and password-reset tokens — is authoritative data with no independent source of truth elsewhere. Uploaded company logos (local disk under `server/uploads` in the current stopgap storage setup) are not covered by a database backup and need their own copy step if logo loss is unacceptable; this is a known, separately tracked limitation of local-disk file storage (see the original audit's Section L), not something this document can retroactively fix.

## Required minimums for production

| Requirement | Minimum |
|---|---|
| **Frequency** | Full backup at least once every 24 hours. If the hosting provider offers continuous/point-in-time recovery (PITR) via WAL archiving, prefer it — it bounds data loss to seconds/minutes instead of up to a day. |
| **Retention** | At least 7 daily backups and 4 weekly backups kept at all times, so a corruption discovered days after it happened is still recoverable from. |
| **Recovery procedure** | Documented, and actually run at least once before go-live (see verification below) — a backup nobody has ever restored from is not a backup, it's an assumption. |
| **Restore verification** | At minimum quarterly: restore the latest backup into a scratch database and run a basic sanity query (row counts on `companies`/`invoices`/`change_orders` are non-zero and plausible) to confirm the backup file is actually usable, not just present. |
| **Failure alerting** | The backup job's own failure must be visible — a silently-failing nightly cron is worse than no backup at all, because it creates false confidence. At minimum, the job's exit code must be checked and a failure must surface somewhere a human will see it (the platform's own alerting if using a managed provider; a simple exit-code check piped to the logging setup described below if self-managed). |

## If the hosting provider manages backups (preferred for production)

Most managed Postgres providers (a first-party RDS/Cloud SQL/managed-Postgres offering, or a platform like Railway/Render/Supabase/Fly Postgres) provide automated backups and PITR out of the box. In that case:

1. Enable the provider's automated backup feature and set retention to match the minimums above.
2. Enable PITR/WAL archiving if the provider offers it.
3. Record, in the deployment's own operational documentation (not this repo, since it is provider-specific), exactly which provider feature is enabled and its configured retention.
4. Still perform the quarterly restore-verification drill above — a provider's backup feature being "on" is not the same as confirming a restore actually produces a working database.

This repository intentionally does not implement provider-specific backup automation, because doing so before a hosting provider is chosen would be exactly the kind of speculative infrastructure this remediation was told not to fabricate.

## If self-managing Postgres

A minimal, provider-agnostic nightly backup using `pg_dump`, runnable from any host with network access to the database and enough disk to hold the dump:

```bash
#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="/var/backups/contractor-os"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/contractor-os-$TIMESTAMP.dump"

mkdir -p "$BACKUP_DIR"
pg_dump --format=custom --file="$FILE" "$DATABASE_URL"

# Retention: delete dumps older than 30 days, keep at least the last 7 regardless of age.
find "$BACKUP_DIR" -name '*.dump' -mtime +30 -type f | sort | head -n -7 | xargs -r rm --
```

Restore:

```bash
pg_restore --clean --if-exists --dbname="$DATABASE_URL" "$FILE"
```

Run the backup script from cron (or the self-managed host's scheduler) at least daily, and pipe its exit status into the observability setup below so a failed backup is not silent.

## Relationship to the CI pipeline

CI (`.github/workflows/ci.yml`) runs migrations against a disposable database on every push — it is not a substitute for production backups. It exists to catch a broken migration before it ever reaches the real database, which is a different (earlier) line of defense than backing up data that already exists.
