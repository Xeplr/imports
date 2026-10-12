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

function headers(extra) {
  return Object.assign({ 'x-company-id': COMPANY, 'x-workspace-id': WORKSPACE, 'x-test-user': 'u1' }, extra || {});
}

async function call(method, url, body, extra) {
  var res = await fetch(ctx.base + url, { method: method, headers: Object.assign(headers(extra), body ? { 'content-type': 'application/json' } : {}),
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

  ctx.uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeplr-imports-test-'));
  process.env.UPLOAD_DIR = ctx.uploadDir;
  var pg = require('pg');
  ctx.pool = new pg.Pool(PG);

  var express = require('express');
  var imports = require('..');
  var app = express();
  app.use(db.mtMiddleware());
  app.use(function(req, res, next) {   // the app's auth, as far as the router can tell
    if (!req.headers['x-test-user']) return res.status(401).json({ error: 'sign in' });
    req.user = { id: req.headers['x-test-user'], name: 'Tester ' + req.headers['x-test-user'] };
    next();
  });
  app.use('/imports', imports.router({
    config: config,
    resolveTarget: async function(connectionId, dbInfoId) {
      return connectionId === 'pg' && dbInfoId === 'main' ? { dbType: 'postgres', dbConnection: PG } : null;
    },
    listTargets: async function() {
      return [{ connectionId: 'pg', label: 'Local', databases: [{ id: 'main', label: 'Main' }] }];
    }
  }));
  await new Promise(function(resolve) { ctx.server = app.listen(0, '127.0.0.1', resolve); });
  ctx.base = 'http://127.0.0.1:' + ctx.server.address().port;
});

test.after(async function() {
  if (!PG) return;
  if (ctx.server) await new Promise(function(r) { ctx.server.close(r); });
  for (var t of [TABLE + '__xeplr_staging', TABLE + '_import_errors', TABLE, 'pasted_test']) {
    await ctx.pool.query('DROP TABLE IF EXISTS "' + t + '"').catch(function() {});
  }
  await ctx.pool.end();
  await ctx.configDb.destroy();
  await ctx.admin.raw('DROP DATABASE IF EXISTS ' + CONFIG_DB);
  await ctx.admin.destroy();
  fs.rmSync(ctx.uploadDir, { recursive: true, force: true });
});

test('router() refuses to start without what it needs, and UPLOAD_DIR must be absolute', function() {
  var imports = require('..');
  assert.throws(function() { imports.router({ listTargets: function() {}, service: 's' }); }, /needs resolveTarget/);
  assert.throws(function() { imports.router({ resolveTarget: function() {}, service: 's' }); }, /needs listTargets/);
  assert.throws(function() { imports.router({ resolveTarget: function() {}, listTargets: function() {} }); }, /needs `service`/);
  var was = process.env.UPLOAD_DIR;
  try {
    delete process.env.UPLOAD_DIR;
    assert.throws(function() { imports.router({ resolveTarget: function() {}, listTargets: function() {}, service: 's' }); }, /UPLOAD_DIR is not set/);
    process.env.UPLOAD_DIR = 'relative/dir';
    assert.throws(function() { imports.router({ resolveTarget: function() {}, listTargets: function() {}, service: 's' }); }, /must be an absolute path/);
  } finally {
    if (was === undefined) delete process.env.UPLOAD_DIR; else process.env.UPLOAD_DIR = was;
  }
  assert.deepEqual(imports.requiredEnv, ['UPLOAD_DIR', 'XCFG_DB_NAME']);
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
    assert.equal((await call('POST', '/imports/inspect', { filePath: path.join(ctx.uploadDir, 'gone.csv') })).status, 404);
  } finally { fs.rmSync(outside, { force: true }); }
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
  var saved = path.join(ctx.uploadDir, 'back.xlsx');
  fs.writeFileSync(saved, Buffer.from(await file.arrayBuffer()));
  var parsed = [];
  for await (var row of require('@xeplr/actions/lib/formats').getFormat('excel').parsePath(saved, {})) parsed.push(row);
  assert.deepEqual(parsed.map(function(p) { return p.sku; }), ['D2', 'D5']);
  assert.deepEqual(Object.keys(parsed[0]), ['sku', 'qty']);
  assert.deepEqual(fs.readdirSync(ctx.uploadDir).filter(function(n) { return /^dropped-/.test(n); }), [], 'the download is not left behind');

  var clean = await importFile(await upload('stock.csv', csv('E', 2)), [{ targetTable: TABLE, mode: 'append' }]);
  assert.equal((await call('GET', '/imports/history/' + clean.result.results[0].jobId + '/dropped/file')).status, 404);
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
