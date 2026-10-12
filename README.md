# @xeplr/imports

Data imports as a drop-in module. Upload a CSV, Excel or JSON file and check it against the table it is going into. Then load it as a **New table**, an **Append** or a **Replace**. Afterwards you can see and download the rows the database refused, and roll the import back. One package holds the routes, the access catalog and the settings. The screen is [`ImportsPage` in `@xeplr/ui-utils`](https://www.npmjs.com/package/@xeplr/ui-utils).

## What you get

- **Big files, no waiting.** CSV, Excel and JSON files of hundreds of megabytes upload and load in the background, with live progress and a stop button.
- **New table, append or replace.** You choose what happens to the table. A typo in a table's name is caught, so it never turns into a new table.
- **Replace without risk.** The table is only swapped once every row has loaded. An import that fails or is stopped leaves your data exactly as it was.
- **Checked before it loads.** The file's columns are compared with the table first. You see what will be refused, what will be left empty and what matches, before anything is touched.
- **Copy-paste damage repaired.** Rows that a paste from another system folded into one cell are found and put back.
- **Nothing silently lost.** Every row the database refuses is kept with the reason. View it, copy it, or download it as Excel to fix and load again.
- **Full history and undo.** Every import is recorded with who ran it, where it went and how it went, and can be rolled back.
- **Drop-in.** One router and one screen, and the app supplies only its database connections.

Every step underneath is [`@xeplr/actions`](https://www.npmjs.com/package/@xeplr/actions): its file readers, the uploader, the error table and staged loads. This package puts those steps behind HTTP and leaves the app only what is its own.

## Using it

```js
var imports = require('@xeplr/imports');

// routes — mounted at /imports (the access catalog assumes that path)
router.use('/imports', imports.router({
  auth: auth.mtMembershipGate,                         // the app's gate, run before every route
  service: 'my-app',                                   // names this app's import records
  resolveTarget: async function(connectionId, dbInfoId, req) {
    // the database a file loads into, as a login the @xeplr/actions drivers take
    return { dbType: 'postgres', dbConnection: { host, port, user, password, database } };   // or null
  },
  listTargets: async function(req) {
    // the databases this caller may import into, for the picker and for history's labels
    return [{ connectionId: 'c1', label: 'Warehouse', databases: [{ id: 'd1', label: 'sales' }] }];
  }
}));
```

```js
// env.required.js
module.exports = [].concat(imports.requiredEnv /* , … */);
```

```
# .env
UPLOAD_DIR=/data/my-app/uploads          # required, absolute
XCFG_DB_NAME=xeplr_configs               # required: where import records live
XEPLR_AUTH_MIGRATIONS=…,/…/node_modules/@xeplr/imports/migrations-auth
```

On the screen side, add one route for `<ImportsPage/>` and a drawer entry. That is the whole of it.

### What the app supplies, and why only that

| | why it is the app's |
|---|---|
| `auth` | who may call these routes is decided by the app's sign-in, as for every other route |
| `resolveTarget(connectionId, dbInfoId, req)` | where the app keeps its connections, and which of them a caller may use, is its own business. Return `null` for one the caller may not use, and the route answers 404 |
| `listTargets(req)` | the same connections, as a list for the picker |
| `service` | names this app's rows in the shared `import_meta` table. Or pass `config`, an `attachConfig()` instance the app already has |
| `userNames(ids)` (optional) | names for records made before the importer's name was stored on them |

Tenancy comes from the app's `mtMiddleware`, as it does for its other routes. Each import record carries `mtId1`/`mtId2`, and history reads them back through the tenant filter, so another company's or workspace's imports are simply not found. Import records live in `xeplr_configs` and are application-scoped (`registerApplication()` at startup).

Database drivers are the app's own: install `pg`, `mysql2`, `mssql` or `@duckdb/node-api` for each kind of database it imports into. The file readers (CSV, Excel) come with this package.

## Settings

| Variable | Required | Meaning |
|---|---|---|
| `UPLOAD_DIR` | **yes**, absolute | Where uploaded files are staged until imported, and where a dropped-rows download is written for the moment it is sent. Never defaulted: a missing or relative one would make the same install read different files depending on where it was started. `router()` refuses to start without it. |
| `XCFG_DB_NAME` | **yes** | The `xeplr_configs` database holding `import_meta`. The login is `XCFG_DB_CONNECTION_INFO_ENCRYPTED`, or the shared `XEPLR_DB_CONNECTION` (`@xeplr/db`) |
| `UPLOAD_MAX_MB` | no | The largest file accepted, default 500. Files go to disk and are streamed, so this costs disk, not memory. A proxy in front (nginx `client_max_body_size`) must allow at least as much |
| `IMPORT_TIME_LIMIT_MINUTES` | no | How long an import may run before it is stopped, default 60 |

## Routes

Mounted at `/imports`:

| Method | Path | |
|---|---|---|
| POST | `/files` | The file (multipart, field `file`) → `{ filePath, fileName, originalName, size }` |
| POST | `/inspect` | `{ filePath }` → `{ format, sheets?, checks }`. `checks` lists what is wrong before anything loads: rows pasted into one cell, with "Recover them" as a choice |
| POST | `/check-target` | `{ filePath, sheet?, connectionId, dbInfoId, targetTable }` → `{ exists, matched, extra, missing: [{ name, required }] }` |
| POST | `/commit` | `{ filePath, connectionId, dbInfoId, originalFileName?, mappings: [{ sheet?, targetTable, mode, repairPastedRows?, primaryKeys? }] }` → **202** `{ runId }`. The import runs in the background. The same file is never imported twice at once (409) |
| GET | `/runs/:id` | `{ status: running \| complete \| error \| stopped, progress, result: { results }, error }`. A run is shown only to the person who started it. Kept an hour after it ends |
| POST | `/runs/:id/stop` | Stops it within a batch |
| GET | `/targets` | `listTargets` |
| GET | `/history` | Past imports, newest first: `{ id, originalFileName, part, targetTable, destination, status, mode, totalRows, rowsLoaded, rowsDropped, errorMessage, createdByName, startedAt }` |
| GET | `/history/:id/dropped` | The rows the database refused, from `<table>_import_errors`: `{ columns, rows: [{ rowNum, reason, values }], total, dropped }`, the first 1,000 |
| GET | `/history/:id/dropped/file` | The same rows as .xlsx: the file's columns only, header in row 1, so it imports again once fixed. The reason is not a column, because it would be refused on the way back in |
| POST | `/history/:id/rollback` | Deletes what the import loaded |
| POST | `/history/:id/delete` | Removes the record only. The data stays |

A commit result per part is `{ targetTable, sheet, success, rows, dropped, jobId, recovered, error }`.

## The rules

- **Modes.** A **New table** must not exist yet. **Append** and **Replace** need one that does, so a typo is never a fresh table. A **Replace** is staged: the rows load into a staging table, then one transaction empties the table and moves them in. A Replace that fails or is stopped leaves the table as it was. See [`@xeplr/actions` Import modes](https://www.npmjs.com/package/@xeplr/actions#import-modes).
- **Rollback is refused for a Replace**, because the rows it replaced are gone. It is also refused for an upsert (`primaryKeys`), which may only have updated rows that already existed.
- **Refused rows are kept.** Each row the database refuses goes to `<table>_import_errors` with its place in the file and the reason, so it can be seen, fixed and loaded again. An import gives up after five refusals in a row, and rows after that are counted but not kept.
- **A filePath is checked.** It comes from the client, so only a path inside `UPLOAD_DIR` is accepted. A file the import cannot read is removed at inspect, and an imported file is removed when its import ends.

## Access

`migrations-auth/0001_imports_access.sql` registers every route by group: `imports:view` (history, dropped rows, runs, targets), `imports:create` (upload, inspect, check, commit, stop) and `imports:edit` (rollback, delete). It maps all of them to Super Admin and CompanyAdmin. Loading data into a company's databases is an administrator's job, so Creator and Viewer get none. An app that wants them to can map those roles in its own migration. Inserts are idempotent.

## Tests

```
PG_HOST=… PG_PORT=… PG_USER=… PG_PASSWORD=… PG_DATABASE=… npm test
```

The real router runs in an Express app, against real Postgres and a throwaway `xeplr_config_imports_test`. The tests cover:

- refused paths and types
- pasted rows found and recovered
- each mode and its refusals
- refused rows shown and downloaded
- history scoped to a workspace
- rollback, with a Replace refused
- delete
- a stopped Replace leaving the table untouched
- runs that only their importer can see

Without `PG_HOST`, only the startup checks run.
