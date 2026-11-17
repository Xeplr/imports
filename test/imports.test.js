// The import routes end to end: the real router in a real Express app, real
// Postgres for the tables imported into, and a real (throwaway) xeplr_configs
// for the import records. Runs when PG_HOST/PG_PORT/PG_USER/PG_PASSWORD (and
// PG_DATABASE, the database imported into) are set; skipped otherwise.
//
// What the app supplies is supplied here the way an app does: tenancy from
// headers (registerMTs + mtMiddleware), a person from its auth (here, a
// header), and its connections (resolveTarget/listTargets) — one Postgres.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var PG = process.env.PG_HOST ? { host: process.env.PG_HOST, port: Number(process.env.PG_PORT || 5432),
  user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE || 'postgres' } : null;
var skip = PG ? false : 'PG_HOST not set — no Postgres';

var CONFIG_DB = 'xeplr_config_imports_test';
var COMPANY = 'c1', WORKSPACE = 'w1';
var TABLE = 'imports_test_' + Date.now().toString(36);

var ctx = {};
var told = [];

/** What the stream was told about one run, in order. */
function toldAbout(runId) {
  return told.filter(function(t) { return t.event.runId === runId; });
}

/** Wait until the stream has heard a run end, and give its last word. */
async function ending(runId) {
  for (var i = 0; i < 600; i++) {
    var last = toldAbout(runId).slice(-1)[0];
    if (last && last.event.status !== 'running') return last;
    await new Promise(function(r) { setTimeout(r, 50); });
  }
  throw new Error('the run was never said to end');
}

// The data root an app sets (XEPLR_DATA_DIR): each tenant's uploads are in its
// own folder under it, <root>/xeplr-imports-test/<company>/<workspace>/uploads.
var DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xeplr-imports-data-')));
process.env.XEPLR_DATA_DIR = DATA;
var UPLOADS = path.join(DATA, 'xeplr-imports-test', COMPANY, WORKSPACE, 'uploads');

function headers(extra) {
  return Object.assign({ 'x-company-id': COMPANY, 'x-workspace-id': WORKSPACE, 'x-test-user': 'u1' }, extra || {});
}

async function call(method, url, body, extra, base) {
  var res = await fetch((base || ctx.base) + url, { method: method, headers: Object.assign(headers(extra), body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined });
  var text = await res.text();
  var json = null;
  try { json = JSON.parse(text); } catch (_) { /* a file */ }
  return { status: res.status, body: json, res: res };
}

async function upload(name, content, type) {
  var form = new FormData();
  form.append('file', new Blob([content], { type: type || 'text/csv' }), name);
  var res = await fetch(ctx.base + '/imports/files', { method: 'POST', headers: headers(), body: form });
  return (await res.json()).filePath;
}

/** Commit, then ask how it is going until it ends — as the page does. */
async function importFile(filePath, mappings, name) {
  var started = await call('POST', '/imports/commit', { filePath: filePath, connectionId: 'pg', dbInfoId: 'main',
    originalFileName: name || 'stock.csv', mappings: mappings });
  if (started.status !== 202) return { refused: started };
  for (var i = 0; i < 300; i++) {
    var run = (await call('GET', '/imports/runs/' + started.body.runId)).body;
    if (run.status !== 'running') return run;
    await new Promise(function(r) { setTimeout(r, 100); });
  }
  throw new Error('the import did not end');
}

function csv(prefix, n, opts) {
  opts = opts || {};
  var lines = ['sku,qty'];
  for (var i = 1; i <= n; i++) lines.push(prefix + i + ',' + ((opts.bad || []).indexOf(i) >= 0 ? -1 : i));
  return lines.join('\n');
}

async function skus() {
  return (await ctx.pool.query('SELECT sku FROM "' + TABLE + '" ORDER BY sku')).rows.map(function(r) { return r.sku; });
}

test.before(async function() {
  if (!PG) return;
  var db = require('@xeplr/db');
  db.registerApplication('xeplr-imports-test');
  db.registerMTs({ l1: { name: 'company', header: 'x-company-id' }, l2: { name: 'workspace', header: 'x-workspace-id' } });

  var knexLib = require('knex');
  var server = { host: PG.host, port: PG.port, user: PG.user, password: PG.password };
  ctx.admin = knexLib({ client: 'pg', connection: Object.assign({}, server, { database: 'postgres' }), pool: { min: 0, max: 1 } });
  await ctx.admin.raw('DROP DATABASE IF EXISTS ' + CONFIG_DB);
  var boot = await db.bootstrapConfigDb({ connection: server, database: CONFIG_DB, seed: false });
  ctx.configDb = boot.db;
  // The same pieces @xeplr/actions' attachConfig composes, on the test database.
  var makeMetaStore = require('@xeplr/actions/lib/uploader/meta-store-knex');
  var { ImportMeta } = require('@xeplr/actions/lib/uploader/attach');
  var config = {
    ready: async function() {},
    SERVICE_NAME: 'xeplr-imports-test',
    metaStore: makeMetaStore(boot.db, { service: 'xeplr-imports-test', applicationId: 'xeplr-imports-test' }),
    ImportMeta: ImportMeta.bindKnex(boot.db)
  };

  var pg = require('pg');
  ctx.pool = new pg.Pool(PG);

  ctx.config = config;
  var main = await serve({
    // The app's event stream, as far as the router can tell: what it was told, in order.
    publish: function(userId, event) { told.push({ userId: userId, event: JSON.parse(JSON.stringify(event)) }); }
  });
  ctx.server = main.server;
  ctx.base = main.base;
});

/** The import router in an Express app of its own, as an app mounts it — one API process. */
async function serve(extra) {
  var db = require('@xeplr/db');
  var express = require('express');
  var imports = require('..');
  var app = express();
  app.use(db.mtMiddleware());
  app.use(function(req, res, next) {   // the app's auth, as far as the router can tell
    if (!req.headers['x-test-user']) return res.status(401).json({ error: 'sign in' });
    req.user = { id: req.headers['x-test-user'], name: 'Tester ' + req.headers['x-test-user'] };
    next();
  });
  app.use('/imports', imports.router(Object.assign({
    config: ctx.config,
    resolveTarget: async function(connectionId, dbInfoId) {
      return connectionId === 'pg' && dbInfoId === 'main' ? { dbType: 'postgres', dbConnection: PG } : null;
    },
    listTargets: async function() {
      return [{ connectionId: 'pg', label: 'Local', databases: [{ id: 'main', label: 'Main' }] }];
    }
  }, extra)));
  var server = await new Promise(function(resolve) { var srv = app.listen(0, '127.0.0.1', function() { resolve(srv); }); });
  return { server: server, base: 'http://127.0.0.1:' + server.address().port };
}

test.after(async function() {
  if (!PG) return;
  if (ctx.server) await new Promise(function(r) { ctx.server.close(r); });
  for (var t of [TABLE + '__xeplr_staging', TABLE + '_import_errors', TABLE, TABLE + '_big', TABLE + '_big_import_errors', 'pasted_test']) {
    await ctx.pool.query('DROP TABLE IF EXISTS "' + t + '"').catch(function() {});
  }
  await ctx.pool.end();
  try { await require('@xeplr/utils').cache.getClient().quit(); } catch (e) { /* not opened */ }
  await ctx.configDb.destroy();
  await ctx.admin.raw('DROP DATABASE IF EXISTS ' + CONFIG_DB);
  await ctx.admin.destroy();
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('router() refuses to start without what it needs; the data root is required', function() {
  var imports = require('..');
  assert.throws(function() { imports.router({ listTargets: function() {}, service: 's' }); }, /needs resolveTarget/);
  assert.throws(function() { imports.router({ resolveTarget: function() {}, service: 's' }); }, /needs listTargets/);
  assert.throws(function() { imports.router({ resolveTarget: function() {}, listTargets: function() {} }); }, /needs `service`/);
  assert.deepEqual(imports.requiredEnv, ['XEPLR_DATA_DIR', 'XCFG_DB_NAME']);
  assert.ok(fs.existsSync(path.join(imports.authMigrationsDir, '0001_imports_access.sql')));
});

test('a file outside the upload directory, or of a type we do not read, is refused', { skip: skip }, async function() {
  var outside = path.join(os.tmpdir(), 'outside.csv');
  fs.writeFileSync(outside, 'a\n1\n');
  try {
    assert.equal((await call('POST', '/imports/inspect', { filePath: outside })).status, 400);
    assert.equal((await call('POST', '/imports/inspect', {})).status, 400);
    var txt = await upload('notes.txt', 'hello', 'text/plain');
    var r = await call('POST', '/imports/inspect', { filePath: txt });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Unsupported file type/);
    assert.equal(fs.existsSync(txt), false, 'an unreadable upload is removed');
    assert.equal((await call('POST', '/imports/inspect', { filePath: path.join(UPLOADS, 'gone.csv') })).status, 404);
  } finally { fs.rmSync(outside, { force: true }); }
});

test('an upload lands in its own company\'s folder, and another company cannot use it', { skip: skip }, async function() {
  var mine = await upload('stock.csv', csv('Z', 2));
  assert.equal(path.dirname(mine), UPLOADS, 'in <root>/<app>/<company>/<workspace>/uploads');
  var theirs = await call('POST', '/imports/inspect', { filePath: mine }, { 'x-company-id': 'c2' });
  assert.equal(theirs.status, 400, 'another company is refused the file');
  var climb = await call('POST', '/imports/inspect', { filePath: '../../c1/w1/uploads/' + path.basename(mine) }, { 'x-company-id': 'c2' });
  assert.equal(climb.status, 400);
  var ownWorkspace = await call('POST', '/imports/inspect', { filePath: mine }, { 'x-workspace-id': 'w2' });
  assert.equal(ownWorkspace.status, 400, 'and so is another workspace of the same company');
  assert.equal((await call('POST', '/imports/inspect', { filePath: mine })).status, 200);
  var other = await (async function() {
    var form = new FormData();
    form.append('file', new Blob(['sku,qty\nQ1,1\n'], { type: 'text/csv' }), 'q.csv');
    var res = await fetch(ctx.base + '/imports/files', { method: 'POST', headers: headers({ 'x-company-id': 'c2' }), body: form });
    return (await res.json()).filePath;
  })();
  assert.equal(path.dirname(other), path.join(DATA, 'xeplr-imports-test', 'c2', WORKSPACE, 'uploads'));
});

test('inspect finds rows pasted into one cell, per sheet, before anything loads', { skip: skip }, async function() {
  var fp = await upload('costing.xlsx', fs.readFileSync(path.join(__dirname, 'fixtures', 'pasted-rows.xlsx')),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  var r = await call('POST', '/imports/inspect', { filePath: fp });
  assert.equal(r.status, 200);
  assert.equal(r.body.format, 'excel');
  assert.ok(r.body.sheets.indexOf('Costing') >= 0);
  var found = r.body.checks.Costing[0];
  assert.equal(found.key, 'pastedRows');
  assert.match(found.message, /^3 rows were pasted into 1 cell/);
  assert.match(found.fixLabel, /Recover them as 3 separate rows/);
  var done = await importFile(fp, [{ sheet: 'Costing', targetTable: 'pasted_test', mode: 'new', repairPastedRows: true }], 'costing.xlsx');
  assert.equal(done.status, 'complete');
  assert.equal(done.result.results[0].recovered, 3);
  assert.equal(Number((await ctx.pool.query('SELECT count(*) AS n FROM pasted_test')).rows[0].n), 6);
});

test('New table, Append, Replace — each checked against the table first', { skip: skip }, async function() {
  var f1 = await upload('stock.csv', csv('A', 3));
  var none = await call('POST', '/imports/check-target', { filePath: f1, connectionId: 'pg', dbInfoId: 'main', targetTable: TABLE });
  assert.deepEqual(none.body, { exists: false, matched: [], extra: [], missing: [] });
  assert.equal((await call('POST', '/imports/check-target', { filePath: f1, connectionId: 'nope', dbInfoId: 'main', targetTable: TABLE })).status, 404);
  assert.equal((await call('POST', '/imports/check-target', { filePath: f1, connectionId: 'pg', dbInfoId: 'main' })).status, 400);

  var typo = await importFile(f1, [{ targetTable: TABLE, mode: 'append' }]);
  assert.equal(typo.result.results[0].success, false);
  assert.match(typo.result.results[0].error, /does not exist, so there is nothing to append to/);

  var made = await importFile(await upload('stock.csv', csv('A', 3)), [{ targetTable: TABLE, mode: 'new' }]);
  assert.equal(made.result.results[0].success, true);
  assert.deepEqual(await skus(), ['A1', 'A2', 'A3']);

  var f2 = await upload('stock.csv', csv('B', 2));
  var same = await call('POST', '/imports/check-target', { filePath: f2, connectionId: 'pg', dbInfoId: 'main', targetTable: TABLE });
  assert.equal(same.body.exists, true);
  assert.deepEqual(same.body.matched, ['sku', 'qty']);
  var again = await importFile(f2, [{ targetTable: TABLE, mode: 'new' }]);
  assert.match(again.result.results[0].error, /already exists/);
  await importFile(await upload('stock.csv', csv('B', 2)), [{ targetTable: TABLE, mode: 'append' }]);
  assert.equal((await skus()).length, 5);

  var bad = await importFile(await upload('stock.csv', csv('X', 1)), [{ targetTable: TABLE, mode: 'merge' }]);
  assert.equal(bad.refused.status, 400);
  assert.match(bad.refused.body.error, /mode must be one of new, append, replace/);
  var noTable = await importFile(await upload('stock.csv', csv('X', 1)), [{ targetTable: ' ' }]);
  assert.equal(noTable.refused.status, 400);
});

test('rows the database refuses: kept, shown with their reason, downloadable to fix and import again', { skip: skip }, async function() {
  await ctx.pool.query('ALTER TABLE "' + TABLE + '" ADD CONSTRAINT qty_ok CHECK (qty >= 0)');
  var done = await importFile(await upload('stock.csv', csv('D', 6, { bad: [2, 5] })), [{ targetTable: TABLE, mode: 'append' }]);
  var r = done.result.results[0];
  assert.equal(r.dropped, 2);
  var view = await call('GET', '/imports/history/' + r.jobId + '/dropped');
  assert.equal(view.body.total, 2);
  assert.equal(view.body.dropped, 2);
  assert.deepEqual(view.body.rows.map(function(x) { return x.rowNum; }), [2, 5]);
  assert.match(view.body.rows[0].reason, /check constraint "qty_ok"/);
  assert.deepEqual(view.body.columns, ['sku', 'qty']);

  var file = await fetch(ctx.base + '/imports/history/' + r.jobId + '/dropped/file', { headers: headers() });
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /stock - dropped rows\.xlsx/);
  var saved = path.join(DATA, 'back.xlsx');
  fs.writeFileSync(saved, Buffer.from(await file.arrayBuffer()));
  var parsed = [];
  for await (var row of require('@xeplr/actions/lib/formats').getFormat('excel').parsePath(saved, {})) parsed.push(row);
  assert.deepEqual(parsed.map(function(p) { return p.sku; }), ['D2', 'D5']);
  assert.deepEqual(Object.keys(parsed[0]), ['sku', 'qty']);
  var tmp = path.join(DATA, 'xeplr-imports-test', COMPANY, WORKSPACE, 'tmp');
  assert.deepEqual((fs.existsSync(tmp) ? fs.readdirSync(tmp) : []).filter(function(n) { return /^dropped-/.test(n); }), [], 'the download is not left behind');

  var clean = await importFile(await upload('stock.csv', csv('E', 2)), [{ targetTable: TABLE, mode: 'append' }]);
  assert.equal((await call('GET', '/imports/history/' + clean.result.results[0].jobId + '/dropped/file')).status, 404);
});

test('a Parquet file: inspected, checked against the table, loaded with its own types', { skip: skip }, async function() {
  var actions = require('@xeplr/actions');
  var local = path.join(os.tmpdir(), 'events-' + Date.now() + '.parquet');
  await actions.parquet.writeAll([1, 2, 3].map(function(i) {
    return { sku: 'P' + i, qty: i * 1.5, at: new Date(Date.UTC(2026, 0, i, 9)), ok: i % 2 === 0 };
  }), { file: local });
  try {
    var f = await upload('events.parquet', fs.readFileSync(local), 'application/vnd.apache.parquet');
    var seen = await call('POST', '/imports/inspect', { filePath: f });
    assert.equal(seen.status, 200);
    assert.equal(seen.body.format, 'parquet');
    var target = 'parquet_test';
    var check = await call('POST', '/imports/check-target', { filePath: f, connectionId: 'pg', dbInfoId: 'main', targetTable: target });
    assert.deepEqual(check.body, { exists: false, matched: [], extra: [], missing: [] });
    var made = await importFile(f, [{ targetTable: target, mode: 'new' }], 'events.parquet');
    assert.equal(made.result.results[0].success, true, JSON.stringify(made.result));
    var types = {};
    (await ctx.pool.query('SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1', [target])).rows
      .forEach(function(r) { types[r.column_name] = r.data_type; });
    assert.equal(types.at, 'timestamp with time zone');
    assert.equal(types.ok, 'boolean');
    assert.notEqual(types.qty, 'text');
    assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM ' + target)).rows[0].n, 3);
  } finally {
    fs.rmSync(local, { force: true });
    await ctx.pool.query('DROP TABLE IF EXISTS parquet_test').catch(function() {});
  }
});

test('history: newest first, with mode, destination and who; another workspace sees none of it', { skip: skip }, async function() {
  var h = (await call('GET', '/imports/history')).body.dataArray.filter(function(j) { return j.targetTable === TABLE; });
  assert.ok(h.length >= 4);
  assert.ok(new Date(h[0].startedAt) >= new Date(h[h.length - 1].startedAt));
  assert.ok(h.some(function(j) { return j.mode === 'new'; }) && h.some(function(j) { return j.mode === 'append'; }));
  assert.equal(h[0].destination, 'Local / Main');
  assert.equal(h[0].createdByName, 'Tester u1');
  var other = (await call('GET', '/imports/history', null, { 'x-workspace-id': 'w2' })).body.dataArray;
  assert.equal(other.length, 0);
  assert.equal((await call('GET', '/imports/history/' + h[0].id + '/dropped', null, { 'x-workspace-id': 'w2' })).status, 404);
  assert.deepEqual((await call('GET', '/imports/targets')).body.dataArray[0].databases, [{ id: 'main', label: 'Main' }]);
});

test('rollback undoes an Append; a Replace cannot be rolled back; delete removes only the record', { skip: skip }, async function() {
  var before = (await skus()).length;
  var added = await importFile(await upload('stock.csv', csv('F', 2)), [{ targetTable: TABLE, mode: 'append' }]);
  assert.equal((await skus()).length, before + 2);
  var rb = await call('POST', '/imports/history/' + added.result.results[0].jobId + '/rollback');
  assert.equal(rb.status, 200);
  assert.equal(rb.body.mainDeleted, 2);
  assert.equal((await skus()).length, before);
  assert.match((await call('POST', '/imports/history/' + added.result.results[0].jobId + '/rollback')).body.error, /Only a completed import/);

  var replaced = await importFile(await upload('stock.csv', csv('R', 2)), [{ targetTable: TABLE, mode: 'replace' }]);
  assert.deepEqual(await skus(), ['R1', 'R2']);
  var refused = await call('POST', '/imports/history/' + replaced.result.results[0].jobId + '/rollback');
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /replaced the table's rows/);
  assert.deepEqual(await skus(), ['R1', 'R2']);

  assert.equal((await call('POST', '/imports/history/' + replaced.result.results[0].jobId + '/delete')).status, 200);
  var left = (await call('GET', '/imports/history')).body.dataArray.map(function(j) { return j.id; });
  assert.equal(left.indexOf(replaced.result.results[0].jobId), -1);
  assert.deepEqual(await skus(), ['R1', 'R2'], 'deleting the record leaves the data');
  assert.equal((await call('POST', '/imports/history/nope/delete')).status, 404);
  assert.equal((await call('POST', '/imports/history/nope/rollback')).status, 404);
});

test('a big file\'s check runs in the background and is told to the stream, as its import is', { skip: skip }, async function() {
  var rows = ['sku,qty'];
  for (var i = 0; i < 300000; i++) rows.push('B' + i + ',' + i);
  var fp = await upload('big-check.csv', rows.join('\n'));
  var bytes = fs.statSync(path.join(UPLOADS, path.basename(fp))).size;

  var started = await call('POST', '/imports/inspect', { filePath: fp, background: true });
  assert.equal(started.status, 202, 'answered at once, with a run');
  assert.match(started.body.runId, /^imp_/);
  var last = await ending(started.body.runId);
  assert.equal(last.userId, 'u1', 'told to the person who asked, nobody else');
  assert.deepEqual(last.event, {
    type: 'import-run', runId: started.body.runId, kind: 'check', status: 'complete',
    progress: { phase: 'checking', part: 1, parts: 1, sheet: null, rowsRead: 300000, bytesRead: bytes, bytes: bytes },
    result: { format: 'csv', checks: {} }, error: null
  }, 'the ending carries the same answer the plain inspect gives, and how far it read');
  var plain = await call('POST', '/imports/inspect', { filePath: fp });
  assert.deepEqual(plain.body, { format: 'csv', checks: {} }, 'without background: the old answer, unchanged');

  var run = (await call('GET', '/imports/runs/' + started.body.runId)).body;
  assert.equal(run.kind, 'check');
  assert.deepEqual(run.result, last.event.result, 'asking gives the same as being told');
  assert.equal((await call('GET', '/imports/runs/' + started.body.runId, null, { 'x-test-user': 'u2' })).status, 404);

  // Stopped: said as stopped, with why.
  var again = await call('POST', '/imports/inspect', { filePath: fp, background: true });
  assert.equal((await call('POST', '/imports/runs/' + again.body.runId + '/stop')).body.stopped, true);
  var stopped = await ending(again.body.runId);
  assert.equal(stopped.event.status, 'stopped');
  assert.equal(stopped.event.error, 'Stopped');
  assert.equal(stopped.event.kind, 'check');

  // The import is told the same way: running at most once a second, then its ending with the results.
  var done = await importFile(fp, [{ targetTable: TABLE + '_big', mode: 'new' }], 'big-check.csv');
  assert.equal(done.status, 'complete');
  var imported = toldAbout(done.id);
  var end = imported[imported.length - 1].event;
  assert.equal(end.kind, 'import');
  assert.equal(end.status, 'complete');
  assert.equal(end.result.results[0].rows, 300000);
  assert.ok(imported.every(function(t) { return t.userId === 'u1'; }));
});

test('several processes: a run is followed and stopped from another, and one file is imported once', { skip: skip }, async function(t) {
  var { RunStore } = require('@xeplr/utils');
  var probe = new RunStore({ store: 'redis' });
  try { await probe.client().ping(); } catch (e) { t.skip('no Redis available'); return; }
  // Two app processes, each with its own Redis connections, as two API workers have.
  var prefix = 'xruns-imports-test-' + process.pid;
  var storeA = new RunStore({ store: 'redis', prefix: prefix });
  var storeB = new RunStore({ store: 'redis', prefix: prefix });
  var a = await serve({ runStore: storeA });
  var b = await serve({ runStore: storeB });
  await storeA.listening(); await storeB.listening();
  try {
    var rows = ['sku,qty'];
    for (var i = 0; i < 2000000; i++) rows.push('P' + i + ',' + i);
    var fp = await upload('procs.csv', rows.join('\n'));

    // Over CHECK_MAX_ROWS the check is skipped at once, and says so.
    var t0 = Date.now();
    var skipped = await call('POST', '/imports/inspect', { filePath: fp }, null, a.base);
    assert.deepEqual(skipped.body.checks, { '': [{ key: 'notChecked',
      message: 'Not checked for rows pasted into one cell: the file has more than 1,000,000 rows.', examples: [] }] });
    assert.ok(Date.now() - t0 < 2000, 'skipped, not read (' + (Date.now() - t0) + ' ms)');

    // The import: started on one process, followed and stopped from the other.
    var one = await call('POST', '/imports/commit', { filePath: fp, connectionId: 'pg', dbInfoId: 'main',
      mappings: [{ targetTable: TABLE + '_procs', mode: 'new' }] }, null, a.base);
    assert.equal(one.status, 202);
    var id = one.body.runId;
    var seen = (await call('GET', '/imports/runs/' + id, null, null, b.base)).body;
    assert.equal(seen.status, 'running', 'the other process sees the run');
    assert.equal(seen.kind, 'import');
    assert.equal((await call('GET', '/imports/runs/' + id, null, { 'x-test-user': 'u2' }, b.base)).status, 404, 'nobody else does');
    assert.equal((await call('POST', '/imports/runs/' + id + '/stop', null, { 'x-test-user': 'u2' }, b.base)).status, 404);

    // One file, imported once — the second press lands on the other process.
    var two = await call('POST', '/imports/commit', { filePath: fp, connectionId: 'pg', dbInfoId: 'main',
      mappings: [{ targetTable: TABLE + '_procs', mode: 'new' }] }, null, b.base);
    assert.equal(two.status, 409, 'refused on the other process too');

    assert.equal((await call('POST', '/imports/runs/' + id + '/stop', null, null, b.base)).body.stopped, true, '✕ on the other process');
    var ended;
    for (var n = 0; n < 200; n++) {
      ended = (await call('GET', '/imports/runs/' + id, null, null, b.base)).body;
      if (ended.status !== 'running') break;
      await new Promise(function(r) { setTimeout(r, 50); });
    }
    assert.equal(ended.status, 'stopped', 'the work in the first process stopped');
    assert.equal(ended.error, 'Stopped');
  } finally {
    await new Promise(function(r) { a.server.close(r); });
    await new Promise(function(r) { b.server.close(r); });
    await storeA.close(); await storeB.close();
    await ctx.pool.query('DROP TABLE IF EXISTS "' + TABLE + '_procs"').catch(function() {});
    await ctx.pool.query('DROP TABLE IF EXISTS "' + TABLE + '_procs_import_errors"').catch(function() {});
  }
});

test('a run is the importer\'s own, and it can be stopped', { skip: skip }, async function() {
  var big = ['sku,qty'];
  for (var i = 0; i < 200000; i++) big.push('S' + i + ',' + i);
  var fp = await upload('big.csv', big.join('\n'));
  var started = await call('POST', '/imports/commit', { filePath: fp, connectionId: 'pg', dbInfoId: 'main', mappings: [{ targetTable: TABLE, mode: 'replace' }] });
  assert.equal(started.status, 202);
  var again = await call('POST', '/imports/commit', { filePath: fp, connectionId: 'pg', dbInfoId: 'main', mappings: [{ targetTable: TABLE, mode: 'append' }] });
  assert.equal(again.status, 409, 'the same file is not imported twice at once');
  assert.equal((await call('GET', '/imports/runs/' + started.body.runId, null, { 'x-test-user': 'u2' })).status, 404);
  assert.equal((await call('POST', '/imports/runs/' + started.body.runId + '/stop', null, { 'x-test-user': 'u2' })).status, 404);
  assert.equal((await call('POST', '/imports/runs/' + started.body.runId + '/stop')).body.stopped, true);
  var run;
  for (var n = 0; n < 300; n++) {
    run = (await call('GET', '/imports/runs/' + started.body.runId)).body;
    if (run.status !== 'running') break;
    await new Promise(function(r) { setTimeout(r, 100); });
  }
  assert.equal(run.status, 'stopped');
  assert.deepEqual(await skus(), ['R1', 'R2'], 'a stopped Replace leaves the table as it was');
  assert.equal((await call('GET', '/imports/runs/nope')).status, 404);
  assert.equal((await call('POST', '/imports/runs/nope/stop')).status, 404);
});
