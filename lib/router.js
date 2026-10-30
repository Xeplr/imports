// THE IMPORT ROUTES, mounted whole by an app:
//
//   router.use('/imports', imports.router({ auth, resolveTarget, listTargets, service }))
//
//   POST /files                       the file (multipart "file") → { filePath, … }
//   POST /inspect                     { filePath } → { format, sheets?, checks }
//   POST /check-target                { filePath, sheet?, connectionId, dbInfoId, targetTable } → { exists, matched, extra, missing }
//   POST /commit                      { filePath, connectionId, dbInfoId, originalFileName?, mappings } → 202 { runId }
//   GET  /runs/:id                    { status, progress, result, error } — the importer's own runs only
//   POST /runs/:id/stop
//   GET  /targets                     the databases a person may import into (the app's listTargets)
//   GET  /history                     past imports, newest first
//   GET  /history/:id/dropped         the rows the database refused, with reasons
//   GET  /history/:id/dropped/file    the same rows as .xlsx, to fix and import again
//   POST /history/:id/rollback        delete what the import loaded (not a Replace, not an upsert)
//   POST /history/:id/delete          remove the record only
//
// The app supplies only what is its own: who may call these (auth), and its
// connections (resolveTarget, listTargets). Tenancy comes from the app's
// mtMiddleware, as for every other route: import records carry mtId1/mtId2 and
// are read back through the tenant filter.

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var express = require('express');
var { uploadRoute } = require('@xeplr/base-apis');
var { getMtContext } = require('@xeplr/db');
var { attachConfig, dataDir } = require('@xeplr/actions');
var imports = require('./imports');
var runs = require('./runs');

/**
 * @param {object} options
 * @param {Function|Function[]} options.auth - middleware run before every route (the app's gate)
 * @param {(connectionId, dbInfoId, req) => Promise<{ dbType, dbConnection, label? } | null>} options.resolveTarget
 *        the database a part loads into, as a login the drivers take; null when it is not one this caller may use
 * @param {(req) => Promise<[{ connectionId, label, databases: [{ id, label }] }]>} options.listTargets
 *        the databases this caller may import into, for the picker and for history's labels
 * @param {string} [options.service] - names this app's import records (import_meta.service). Required without `config`.
 * @param {object} [options.config] - an @xeplr/actions attachConfig() instance the app already has; else one is made
 * @param {(userIds: string[]) => Promise<{ [id]: string }>} [options.userNames] - names for records made before
 *        the importer's name was kept on them
 */
function createRouter(options) {
  options = options || {};
  if (!options.resolveTarget) throw new Error('@xeplr/imports: router() needs resolveTarget(connectionId, dbInfoId, req)');
  if (!options.listTargets) throw new Error('@xeplr/imports: router() needs listTargets(req)');
  var config = options.config || (options.service ? attachConfig({ service: options.service }) : null);
  if (!config) throw new Error('@xeplr/imports: router() needs `service` (names this app\'s import records) or `config`');
  var s = imports.settings();
  var router = express.Router();
  var auth = options.auth ? (Array.isArray(options.auth) ? options.auth : [options.auth]) : [];
  var inFlight = new Set();

  if (auth.length) router.use(auth);
  router.use(function(req, res, next) { config.ready().then(function() { next(); }, next); });
  router.use(express.json({ limit: '1mb' }));

  // The file itself — @xeplr/base-apis' generic receive-and-store.
  // Into the requesting tenant's own uploads/ (imports.uploadDir), asked per
  // upload: the folder depends on who is asking.
  router.use('/files', uploadRoute({ destination: function() { return imports.uploadDir(); }, maxSize: s.maxUploadMb * 1024 * 1024 }));

  /** The uploaded file a body names, checked: in this tenant's uploads, there, and a format we read. */
  function fileOf(body) {
    var given = body && body.filePath;
    if (!given) return { status: 400, error: 'filePath is required' };
    var filePath = imports.uploadedFile(given);
    if (!filePath) return { status: 400, error: 'Invalid filePath' };
    if (!fs.existsSync(filePath)) return { status: 404, error: 'Upload not found — it may have expired. Please upload the file again.' };
    var format = imports.formatOf(filePath);
    if (!format) return { status: 400, error: 'Unsupported file type — use CSV, JSON, or Excel (.xlsx/.xls)' };
    return { filePath: filePath, format: format };
  }

  async function targetOf(connectionId, dbInfoId, req) {
    if (!connectionId || !dbInfoId) return null;
    return options.resolveTarget(connectionId, dbInfoId, req);
  }

  router.post('/inspect', handle(async function(req, res) {
    var file = fileOf(req.body);
    if (file.error) {
      if (file.status === 400 && req.body && req.body.filePath && /Unsupported/.test(file.error)) {
        await fs.promises.unlink(req.body.filePath).catch(function() {});
      }
      return res.status(file.status).json({ error: file.error });
    }
    var sheets = file.format === 'excel' ? await imports.listSheets(file.filePath) : undefined;
    res.json({ format: file.format, sheets: sheets, checks: await imports.inspectChecks(file.filePath, file.format, sheets) });
  }));

  router.post('/check-target', handle(async function(req, res) {
    var b = req.body || {};
    var file = fileOf(b);
    if (file.error) return res.status(file.status).json({ error: file.error });
    if (!b.targetTable) return res.status(400).json({ error: 'targetTable is required' });
    var target = await targetOf(b.connectionId, b.dbInfoId, req);
    if (!target) return res.status(404).json({ error: 'Database not found' });
    res.json(await imports.checkTarget({ filePath: file.filePath, format: file.format, sheet: b.sheet || null,
      dbType: target.dbType, dbConnection: target.dbConnection, targetTable: String(b.targetTable).trim() }));
  }));

  router.post('/commit', handle(async function(req, res) {
    var b = req.body || {};
    var mappings = b.mappings;
    if (!Array.isArray(mappings) || !mappings.length) return res.status(400).json({ error: 'At least one mapping is required' });
    var file = fileOf(b);
    if (file.error) return res.status(file.status).json({ error: file.error });
    var badMode = mappings.filter(function(m) { return m.mode != null && imports.MODES.indexOf(m.mode) === -1; })[0];
    if (badMode) return res.status(400).json({ error: 'mode must be one of ' + imports.MODES.join(', ') });
    if (mappings.some(function(m) { return !m.targetTable || !String(m.targetTable).trim(); })) {
      return res.status(400).json({ error: 'Every mapping needs a targetTable' });
    }
    var target = await targetOf(b.connectionId, b.dbInfoId, req);
    if (!target) return res.status(404).json({ error: 'Database not found' });
    // ONE IMPORT PER FILE AT A TIME: a second press, or a retry after the
    // browser gave up waiting, would load the same rows twice.
    if (inFlight.has(file.filePath)) {
      return res.status(409).json({ error: 'This file is already being imported. Wait for it to finish.' });
    }
    inFlight.add(file.filePath);

    var mt = getMtContext() || {};
    var user = req.user || {};
    var count = mappings.length;
    var runId = runs.startRun(async function(onProgress, signal) {
      try {
        var results = [];
        for (var i = 0; i < mappings.length; i++) {
          if (signal.aborted) break;
          var m = mappings[i];
          var movementId = crypto.randomBytes(12).toString('hex');
          var outcome = await imports.loadPart({
            filePath: file.filePath, format: file.format, sheet: m.sheet || null,
            dbType: target.dbType, dbConnection: target.dbConnection,
            targetTable: String(m.targetTable).trim(), primaryKeys: m.primaryKeys, mode: m.mode,
            repairPastedRows: Boolean(m.repairPastedRows),
            movementId: movementId, signal: signal,
            onProgress: progressFor(onProgress, i, count, m.sheet),
            mtId1: mt.mtId1, mtId2: mt.mtId2,
            details: {
              connectionId: b.connectionId, dbInfoId: b.dbInfoId,
              // The person's own name for the file — never the stored one, a
              // random id that means nothing to anybody.
              originalFileName: b.originalFileName || null,
              part: m.sheet || null,
              recordCreatedBy: user.id || null,
              // Kept on the record, so history can say who without asking
              // the app's user store.
              recordCreatedByName: user.name || user.email || null
            }
          }, config.metaStore);
          results.push({
            targetTable: String(m.targetTable).trim(),
            sheet: m.sheet || null,
            success: outcome.status === 'success',
            rows: outcome.output ? outcome.output.totalRows : null,
            dropped: outcome.output ? (outcome.output.dropped || 0) : null,
            jobId: movementId,
            recovered: outcome.output && outcome.output.repairedPastedRows ? outcome.output.repairedPastedRows.rows : null,
            error: outcome.error ? outcome.error.message : null
          });
        }
        return { results: results };
      } finally {
        inFlight.delete(file.filePath);
        await fs.promises.unlink(file.filePath).catch(function() {});
      }
    }, { userId: user.id, timeLimitMs: s.timeLimitMs });
    res.status(202).json({ runId: runId });
  }));

  router.get('/runs/:id', function(req, res) {
    var run = runs.view(req.params.id, req.user && req.user.id);
    if (!run) return res.status(404).json({ error: 'No such import run' });
    res.json(run);
  });

  router.post('/runs/:id/stop', function(req, res) {
    var run = runs.view(req.params.id, req.user && req.user.id);
    if (!run) return res.status(404).json({ error: 'No such import run' });
    res.json({ stopped: runs.stop(req.params.id, 'Stopped') });
  });

  router.get('/targets', handle(async function(req, res) {
    res.json({ dataArray: (await options.listTargets(req)) || [] });
  }));

  /** One import record of this app, through the tenant filter — another company's is simply not found. */
  async function jobOf(id) {
    return config.ImportMeta.query().where('service', config.SERVICE_NAME).findById(id);
  }

  router.get('/history', handle(async function(req, res) {
    var jobs = await config.ImportMeta.query().where('service', config.SERVICE_NAME).orderBy('started_at', 'desc').limit(200);
    var targets = (await options.listTargets(req)) || [];
    var labels = {};
    targets.forEach(function(t) {
      (t.databases || []).forEach(function(d) { labels[t.connectionId + '\u0000' + d.id] = [t.label, d.label].filter(Boolean).join(' / '); });
    });
    var unnamed = jobs.map(function(j) { var d = j.details || {}; return !d.recordCreatedByName && d.recordCreatedBy; }).filter(Boolean);
    var names = unnamed.length && options.userNames ? (await options.userNames(Array.from(new Set(unnamed)))) || {} : {};
    res.json({ dataArray: jobs.map(function(job) {
      var d = job.details || {};
      return {
        id: job.id,
        originalFileName: d.originalFileName,
        part: d.part,
        targetTable: job.target_table,
        destination: labels[d.connectionId + '\u0000' + d.dbInfoId] || null,
        status: job.status,
        mode: imports.modeOf(job),
        totalRows: job.total_rows == null ? null : Number(job.total_rows),
        rowsLoaded: job.completed == null ? null : Number(job.completed),
        rowsDropped: job.dropped == null ? null : Number(job.dropped),
        errorMessage: job.error,
        createdByName: d.recordCreatedByName || names[d.recordCreatedBy] || null,
        startedAt: job.started_at
      };
    }) });
  }));

  /** A record and the database it loaded into, or { status, error }. */
  async function jobAndTarget(req) {
    var job = await jobOf(req.params.id);
    if (!job) return { status: 404, error: 'Import not found' };
    var d = job.details || {};
    var target = await targetOf(d.connectionId, d.dbInfoId, req);
    if (!target) return { status: 404, error: 'The database this import loaded into is no longer available' };
    return { job: job, target: target };
  }

  async function droppedOf(req, limit) {
    var got = await jobAndTarget(req);
    if (got.error) return got;
    got.found = await imports.droppedRows({
      dbType: got.target.dbType, dbConnection: got.target.dbConnection,
      targetTable: got.job.target_table, movementId: got.job.id, columns: got.job.columns, limit: limit
    });
    return got;
  }

  router.get('/history/:id/dropped', handle(async function(req, res) {
    var got = await droppedOf(req);
    if (got.error) return res.status(got.status).json({ error: got.error });
    res.json({ columns: got.found.columns, rows: got.found.rows, total: got.found.total, dropped: Number(got.job.dropped || 0) });
  }));

  router.get('/history/:id/dropped/file', handle(async function(req, res) {
    var got = await droppedOf(req, imports.DROPPED_FILE_ROWS);
    if (got.error) return res.status(got.status).json({ error: got.error });
    if (!got.found.rows.length) return res.status(404).json({ error: 'No dropped rows were kept for this import' });
    var d = got.job.details || {};
    var base = String(d.originalFileName || got.job.target_table).replace(/\.[^.]+$/, '');
    var name = (base + ' - dropped rows').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ').trim().slice(0, 120) + '.xlsx';
    // In the tenant's own temporary folder — these are customer rows too —
    // and gone once sent. No leading dot in the name: Express will not send a
    // file under one.
    var dir = fs.mkdtempSync(path.join(dataDir.scratch(), 'dropped-'));
    try {
      var filePath = await imports.droppedRowsFile(got.found, path.join(dir, name));
      // With a callback Express leaves a failed send to us — answer it, or
      // the request hangs.
      res.download(filePath, name, function(err) {
        fs.rm(dir, { recursive: true, force: true }, function() {});
        if (err && !res.headersSent) res.status(500).json({ error: 'The file could not be sent: ' + err.message });
      });
    } catch (err) {
      fs.rm(dir, { recursive: true, force: true }, function() {});
      throw err;
    }
  }));

  router.post('/history/:id/rollback', handle(async function(req, res) {
    var job = await jobOf(req.params.id);
    if (!job) return res.status(404).json({ error: 'Import not found' });
    if (job.status !== 'completed') return res.status(400).json({ error: 'Only a completed import can be rolled back' });
    if (imports.modeOf(job) === 'replace') {
      return res.status(400).json({ error: 'This import replaced the table\'s rows, and the rows it replaced are gone — ' +
        'deleting the new ones would leave the table empty, not as it was. Import the earlier data again to restore it.' });
    }
    if (job.primary_keys && job.primary_keys.length) {
      return res.status(400).json({ error: 'This import used upsert (matched on ' + job.primary_keys.join(', ') + ') — rollback is ' +
        'disabled because it may have only updated rows that already existed, not created them.' });
    }
    var got = await jobAndTarget(req);
    if (got.error) return res.status(got.status).json({ error: got.error });
    var result = await imports.rollback({ movementId: job.id, dbType: got.target.dbType, dbConnection: got.target.dbConnection,
      targetTable: job.target_table }, config.metaStore);
    res.json({ success: true, mainDeleted: result.mainDeleted, errorDeleted: result.errorDeleted });
  }));

  router.post('/history/:id/delete', handle(async function(req, res) {
    var job = await jobOf(req.params.id);
    if (!job) return res.status(404).json({ error: 'Import not found' });
    await config.ImportMeta.query().findById(job.id).patch({ isActive: false });
    res.json({ success: true });
  }));

  return router;
}

/** Which part of how many, with the uploader's own row counts. */
function progressFor(onProgress, index, count, sheet) {
  return function(p) {
    onProgress(Object.assign({}, p, { mapping: index + 1, mappings: count, sheet: sheet || null }));
  };
}

/** An async route whose failure answers 500 (or the error's own status) with its message. */
function handle(fn) {
  return function(req, res) {
    Promise.resolve(fn(req, res)).catch(function(err) {
      if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
    });
  };
}

module.exports = createRouter;
