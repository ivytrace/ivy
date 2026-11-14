-- Pre-release reset, run once when upgrading a volume from before workspaces and projects.
-- This is not a migration: it DROPS ALL DATA (spans, workspaces, keys, members, AWS connections).
-- Afterwards apply the schema (init.sh) and restart the API and ingest router: they recreate the
-- `default` workspace, its `default` project and the IVY_INGEST_API_KEY key on startup, and users
-- get fresh workspaces when they next sign in. `pnpm db:reset` runs all of it for compose.
DROP DATABASE IF EXISTS ivy SYNC;
DROP DATABASE IF EXISTS ivy_control SYNC;
CREATE DATABASE ivy;
CREATE DATABASE ivy_control;
