-- 0001_imports_access.sql
-- @xeplr/imports' own access catalog: every route lib/router.js serves, by
-- group, and the roles that reach them. The package never runs this itself —
-- a consuming app lists this directory in XEPLR_AUTH_MIGRATIONS
-- (imports.authMigrationsDir), so its auth database knows these routes exist.
--
-- The names assume the app mounts the router at /imports, as the README says.
--
-- Groups:
--   imports:view    see past imports, their dropped rows, a run's progress, the databases
--   imports:create  upload, inspect, check against a table, import, stop one's own import
--   imports:edit    roll an import back, delete its record
--
-- Roles are the shared vocabulary every app's auth database uses (as in
-- @xeplr/jobs' 0001): Super Admin gets everything; CompanyAdmin gets
-- imports:* (its rows stay within its own company through mtId1). Loading
-- data into a company's databases is an administrator's job, so Creator and
-- Viewer get none — an app that wants them to can map them in its own
-- migration. Idempotent: insert-if-absent on name + group, and on each mapping.

INSERT INTO "roles" (id, name, "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), name, true, '*', now(), now()
FROM (VALUES ('Super Admin'), ('CompanyAdmin')) AS v(name)
WHERE NOT EXISTS (SELECT 1 FROM "roles" r WHERE r.name = v.name);

INSERT INTO "apis" (id, name, "apiGroup", "isPublic", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), v.name, v.grp, false, true, '*', now(), now()
FROM (VALUES
  ('POST /imports/files', 'imports:create'),
  ('POST /imports/inspect', 'imports:create'),
  ('POST /imports/check-target', 'imports:create'),
  ('POST /imports/commit', 'imports:create'),
  ('POST /imports/runs/:id/stop', 'imports:create'),
  ('GET /imports/runs/:id', 'imports:view'),
  ('GET /imports/targets', 'imports:view'),
  ('GET /imports/history', 'imports:view'),
  ('GET /imports/history/:id/dropped', 'imports:view'),
  ('GET /imports/history/:id/dropped/file', 'imports:view'),
  ('POST /imports/history/:id/rollback', 'imports:edit'),
  ('POST /imports/history/:id/delete', 'imports:edit')
) AS v(name, grp)
WHERE NOT EXISTS (SELECT 1 FROM "apis" a WHERE a.name = v.name AND a."apiGroup" = v.grp);

INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name IN ('Super Admin', 'CompanyAdmin')
  AND a."apiGroup" LIKE 'imports:%'
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);
