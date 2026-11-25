-- Authored by Tomás Neto (TN 2026)
-- Per-key opt-out of duplicate detection (DEDUP_WINDOW_SECONDS).
ALTER TABLE "api_keys" ADD COLUMN "allow_duplicates" BOOLEAN NOT NULL DEFAULT false;
