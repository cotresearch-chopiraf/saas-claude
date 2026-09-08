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

## `docker-compose.yml` is not a backup solution

The `docker-compose.yml` at the repo root provisions a single Postgres container with one named Docker volume, for local development convenience only. It has no backup step, no retention, and no restore tooling of its own — a volume is not a backup, it is just where the live data happens to live. It is not, and must never be treated as, the production database or a production backup mechanism. A real production deployment uses either a managed Postgres provider (see below) or a separately-hosted, separately-backed-up self-managed instance — never the bare `docker-compose.yml` service as-is.

## RPO / RTO

No production hosting provider has been chosen yet (see `docs/PRODUCTION_LAUNCH_CHECKLIST.md`), so the values below are **TARGET**, not currently-achieved figures — they are the minimum bar the eventual provider/configuration must meet, not a claim about today's infrastructure.

| Metric | Target | Basis |
|---|---|---|
| **RPO** (Recovery Point Objective — how much data loss is acceptable) | ≤ 24 hours, ≤ 15 minutes if PITR/WAL archiving is enabled | Matches the "Required minimums" table above: daily `pg_dump` bounds loss to a day; PITR (preferred, see below) bounds it to whatever the provider's WAL-archive interval is, typically minutes. |
| **RTO** (Recovery Time Objective — how quickly service must be back) | ≤ 4 hours for a full database restore on a self-managed instance; provider SLA (typically much lower) if using a managed Postgres offering with one-click restore | Based on the restore procedure below (`pg_restore` of a multi-GB dump is realistically minutes-to-low-single-digit-hours depending on database size and host I/O) — re-measure and update this once a real hosting provider and realistic data volume are known. |

These targets must be re-validated (and this table updated) once a real provider is chosen and the restore-verification drill (below) has actually been timed against production-scale data.

## Restore procedure (step by step)

This is the full operational sequence, not just the `pg_restore` command — every step before and after it matters as much as the restore itself. Steps marked **⚠️ DESTRUCTIVE** overwrite the target database; never run them against a database you are not certain is the intended target.

1. **Stop/disable application writes.** Scale the API to zero, put it in maintenance mode, or otherwise stop new requests from reaching Postgres — a restore racing live writes produces a database that is neither the backup's state nor the pre-incident live state. (This repository has no built-in maintenance-mode flag; stopping the process/container, or routing traffic away from it at the load balancer/host level, is the mechanism today.)
2. **Identify the correct backup.** Confirm the exact backup file/snapshot timestamp you intend to restore, and confirm it predates the incident (not the same one that may already be corrupted).
3. **Restore the database.** ⚠️ **DESTRUCTIVE to the target database only** — never run this against the live production database as the target unless the intent is genuinely to overwrite it after the outage has already made that data unusable:
   ```bash
   pg_restore --clean --if-exists --dbname="$TARGET_DATABASE_URL" "$BACKUP_FILE"
   ```
   `$TARGET_DATABASE_URL` must point at the database you actually intend to overwrite — double-check this value before running the command.
4. **Run/verify migrations.** Confirm the restored database's migration state matches what the running application code expects:
   ```bash
   npm run db:migrate --workspace server
   ```
   If the backup predates a since-applied migration, this brings the schema forward to match the deployed code. If the backup is already current, this is a safe no-op (Drizzle's migrator only applies migrations not yet recorded as run).
5. **Verify schema.** Spot-check that the tables the application depends on exist and have the expected columns — at minimum `companies`, `users`, `projects`, `contracts`, `boq_revisions`, `ipcs`, `invoices`. A quick `\dt` in `psql` against the restored database is sufficient for a sanity check.
6. **Verify application connectivity.** Point a non-production instance of the API at the restored database (`DATABASE_URL` pointed at it) and confirm it starts without a `StartupConfigError` and without a database-connection error.
7. **Run health checks.** `GET /api/health/ready` against that instance must return `200 {"status":"ok"}` — this is the same check (`SELECT 1`) the production `HEALTHCHECK` uses, so a pass here is a real signal the database is reachable and query-able.
8. **Re-enable the application.** Only once steps 1–7 are confirmed: point production traffic at the restored database and resume accepting writes.
9. **Verify critical business data.** Spot-check a handful of real, known records post-restore (a specific company's project list, a specific certified IPC's `netCertified` value, a specific invoice's line items) against what is independently known to be correct — a restore that "looks" complete (right table/row counts) can still have restored a stale or partially-corrupted snapshot; only checking actual business values catches that.

## Restore verification drill (mandatory, isolated)

A backup that has never been restored is an assumption, not a backup. The drill must run against an **isolated** scratch database — never against the live production database, and never in a way that could be mistaken for step 3 of the real restore procedure above:

```text
Production backup file
        ↓
Temporary, isolated PostgreSQL database
   (a throwaway database/instance nothing else points at —
    never the live production database)
        ↓
pg_restore into the isolated database
        ↓
Run/verify migrations against it
        ↓
Point a non-production API instance at it; confirm
GET /api/health/ready returns 200
        ↓
Verify representative business records (row counts on
companies/users/invoices/change_orders are non-zero and
plausible; spot-check one known record's values)
        ↓
Tear down the isolated database — it was a drill, not a
new environment to keep around
```

Run this quarterly at minimum (see the Required minimums table above), and once before go-live.

**Local demonstration performed in this repository (2026-09-08):** the mechanics above were exercised end-to-end against this environment's local, disposable test database (`audit_test` — synthetic test fixtures only, never real customer data) to confirm the commands themselves are correct: `pg_dump --format=custom` of the local database, `createdb` of an isolated scratch database, `pg_restore --clean --if-exists`, then a row-count comparison (`companies`, `users`, and Drizzle's own `drizzle.__drizzle_migrations` tracking table) between source and restored databases, followed by a `SELECT 1` connectivity check against the restored database (the same query `/api/health/ready` runs) and teardown of the scratch database. Result: table count (50/50), `companies` (2/2), `users` (2/2), and `drizzle_migrations` (33/33) all matched exactly between source and restored database; the connectivity check succeeded.

**This proves the documented commands work correctly — it is not a substitute for the mandatory production drill above.** It used no production credentials, no production data, and no production infrastructure; it does not establish a timing baseline for the RTO target (the local dataset is trivially small compared to real production data) and does not verify any provider-specific backup/restore mechanism. The first real drill, against an actual production-scale backup, using whichever hosting provider is eventually chosen, remains **UNVERIFIED** until performed by an operator with real production access.

## Secrets

Backup storage credentials (cloud storage access keys, managed-provider API tokens, or the `DATABASE_URL` used to connect for a self-managed `pg_dump`) must be managed through the same production secret-management mechanism as every other credential this application uses (an environment variable injected by the hosting platform, a secrets manager, etc.) — never hardcoded, never committed, and never placed in this or any other document in this repository. Nothing in this file contains a real credential, and nothing added to it in the future should either.

## Disaster recovery scenarios

Practical response for each, building on the restore procedure above rather than repeating it:

| Scenario | Response |
|---|---|
| **Database failure** (host/instance crash, unrecoverable) | Provision a new Postgres instance; run the full restore procedure above against the latest backup. |
| **Accidental deletion** (a row, table, or entire database dropped by a person or a bug) | If caught within the PITR window, prefer point-in-time recovery to just before the deletion (minimizes data loss beyond the deletion itself). Otherwise, restore the latest backup prior to the deletion via the full restore procedure, accepting the data-loss window back to that backup. |
| **Corrupted migration** (a bad migration reaches production and leaves the schema in a broken/inconsistent state) | Do not attempt to hand-edit the live schema. Restore the most recent backup taken before the bad migration ran, then apply a corrected migration through the normal `npm run db:migrate` path — never patch around a broken migration in place. |
| **Storage failure** (uploaded files lost — local disk or the configured S3-compatible bucket) | Database backups do not cover uploaded files (see "What must be backed up" above). If `STORAGE_PROVIDER=s3`, rely on the bucket provider's own durability/versioning (e.g. S3 versioning, cross-region replication) — configure this at the provider level; it is outside what this repository's code can do. If `STORAGE_PROVIDER=local`, file loss on host failure is expected and is exactly why `local` is documented as a development-only stopgap, never a production choice. |
| **Deployment rollback** (a bad release needs to be reverted) | Roll back the application container/image to the previous known-good version first. Only restore/roll back the database in addition if the bad release also wrote bad data or ran a destructive migration — most application-level bugs do not require a database restore at all. |
| **Credential compromise** (JWT secret, database password, ZATCA secret-store credentials, or any provider API key leaked or suspected leaked) | Rotate the specific credential immediately at its source (regenerate `JWT_SECRET` — this invalidates every existing session token; rotate the Postgres password at the provider; rotate the S3/Resend/AWS Secrets Manager keys). A JWT secret rotation alone does not require a database restore. If the database credential itself was compromised, also audit for unauthorized data access/modification before resuming normal operation. |
| **Complete application-host failure** (the entire server/hosting environment is gone) | Redeploy the Docker image (already CI-validated to build from a clean checkout, see `.github/workflows/ci.yml`) to a new host, point it at the existing (or, if that host is also gone, freshly restored) database via `DATABASE_URL`, and reapply the full set of required production environment variables (`docs/PRODUCTION_LAUNCH_CHECKLIST.md`). No component of this application's deployment is host-specific. |
