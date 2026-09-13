ALTER TABLE "platform_operators" ALTER COLUMN "role" SET DEFAULT 'platform_owner';--> statement-breakpoint
-- MIDAD Final Pre-Launch audit, Phase 6 — every existing platform_operators
-- row is migrated off the legacy single-value role ("platform_operator")
-- onto "platform_owner", the highest role in the new matrix. This exactly
-- preserves each row's current real-world access level: before this phase
-- the enum had one value and any operator row already had full access, so
-- converting to the highest new role changes no one's actual permissions.
-- Split into a separate migration file from 0047's ADD VALUE statements
-- because Postgres refuses to use a newly added enum value inside the same
-- transaction that added it.
UPDATE "platform_operators" SET "role" = 'platform_owner' WHERE "role" = 'platform_operator';
