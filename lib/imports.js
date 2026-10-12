// WHAT AN IMPORT DOES, apart from HTTP: what a file holds, how it compares
// with the table it names, loading it, and reading back what it refused.
// Every step is @xeplr/actions — this file only puts them in order. The
// routes (router.js) call these; nothing here knows about a request.

var fs = require('fs');
var path = require('path');
var { runAction, builtins, formats, uploader, drivers } = require('@xeplr/actions');

var EXT_TO_FORMAT = { '.csv': 'csv', '.json': 'json', '.xlsx': 'excel', '.xls': 'excel' };

// Rows the dropped-rows view shows at once, and the most a download carries
// (Excel's own limit — past it the sheet would be cut anyway).
var DROPPED_VIEW_ROWS = 1000;
var DROPPED_FILE_ROWS = 1048575;

/**
 * Where uploads are staged and how big one may be, from the environment.
 * UPLOAD_DIR is required and absolute: a missing one would default to
 * somewhere, and a relative one resolves against wherever the process was
 * started — the same install reading different files depending on that.
 */
function settings() {
  var dir = process.env.UPLOAD_DIR;
  if (!dir) throw new Error('@xeplr/imports: UPLOAD_DIR is not set — the absolute directory uploaded files are staged in');
  if (!path.isAbsolute(dir)) throw new Error('@xeplr/imports: UPLOAD_DIR must be an absolute path, got "' + dir + '"');
  fs.mkdirSync(dir, { recursive: true });
  return {
    uploadDir: path.resolve(dir),
    // Client exports run to a few hundred MB (a 773k-row ERP CSV is 270 MB);
    // the file goes to disk and is streamed, so the size costs disk, not memory.
    maxUploadMb: Number(process.env.UPLOAD_MAX_MB) || 500,
    timeLimitMs: (Number(process.env.IMPORT_TIME_LIMIT_MINUTES) || 60) * 60 * 1000
  };
}

function formatOf(filename) {
  return EXT_TO_FORMAT[path.extname(filename).toLowerCase()] || null;
}

/**
 * A filePath comes from the client, relaying what the upload answered — so
 * only one inside the upload directory is accepted, never an arbitrary file
 * on the server.
 */
function isWithin(dir, filePath) {
  var resolved = path.resolve(String(filePath || ''));
  return resolved === dir || resolved.indexOf(dir + path.sep) === 0;
}

function listSheets(filePath) {
  return formats.getFormat('excel').listSheets(filePath);
}

/**
 * What is wrong with the file before anything is loaded — today, rows a paste
 * folded into one cell (see @xeplr/actions formats/pastedRows.js), with the
 * fix offered as a choice. Per sheet for Excel, once ('') for a CSV.
 *
 * @returns {{ [part]: [{ key, message, fixLabel, examples }] }}
 */
async function inspectChecks(filePath, format, sheets) {
  var checks = {};
  if (format !== 'excel' && format !== 'csv') return checks;
  var parts = format === 'excel' ? (sheets || []) : [null];
  for (var i = 0; i < parts.length; i++) {
    var found = await formats.scanPastedRows(format, filePath, parts[i] ? { sheet: parts[i], examples: 3 } : { examples: 3 });
    if (!found.cells) continue;
    checks[parts[i] == null ? '' : parts[i]] = [{
      key: 'pastedRows',
      message: plural(found.rows, 'row') + (found.rows === 1 ? ' was' : ' were') + ' pasted into ' + plural(found.cells, 'cell') +
        ' — they exist nowhere else in the file. This happens when data copied out of another system is pasted into Excel and a value starts with a quote mark (an inch mark).',
      fixLabel: 'Recover them as ' + plural(found.rows, 'separate row'),
      examples: found.examples.map(function(e) {
        return 'Row ' + e.row + ', ' + e.column + ': holds ' + plural(e.rows, 'more row') + ' — begins with ' + e.first;
      })
    }];
  }
  return checks;
}

/**
 * One part of a file against the table it names — said before loading: does
 * the table exist, which file columns does it lack (the import would be
 * refused), which of its columns does the file lack (left empty, or every row
 * refused when required).
 *
 * @returns {Promise<{ exists, matched, extra, missing: [{ name, required }] }>}
 */
async function checkTarget(opts) {
  var columns = await formats.columnsOf(opts.format, opts.filePath, opts.sheet ? { sheet: opts.sheet } : {});
  return uploader.compareToTable({
    driver: drivers.db.getDriver(opts.dbType),
    connection: opts.dbConnection,
    targetTable: opts.targetTable,
    columns: columns
  });
}

/**
 * Load one part of a file into one table: the file-upload action, which
 * records the import (import_meta) before writing a row. Never throws — the
 * caller reports each part's outcome without stopping the others.
 */
async function loadPart(opts, metaStore) {
  var outcome = await runAction(builtins.fileUpload, {
    sourceType: 'local',
    sourcePath: opts.filePath,
    format: opts.format,
    formatConfig: Object.assign(opts.sheet ? { sheet: opts.sheet } : {}, opts.repairPastedRows ? { repairPastedRows: true } : {}),
    dbType: opts.dbType,
    dbConnection: opts.dbConnection,
    targetTable: opts.targetTable,
    primaryKeys: opts.primaryKeys,
    mode: opts.mode || undefined,
    movementId: opts.movementId
  }, {
    system: { mtId1: opts.mtId1, mtId2: opts.mtId2, details: opts.details, onProgress: opts.onProgress || null, signal: opts.signal || null },
    metaStore: metaStore
  });
  // An action that failed before its own ending was recorded would leave the
  // import 'running' forever. recordEnd is an upsert, so this is harmless when
  // the uploader already closed it.
  if (outcome.status !== 'success') {
    await metaStore.recordEnd(opts.movementId, {
      status: 'failed',
      error: outcome.error && outcome.error.message,
      targetTable: opts.targetTable, connectionKey: opts.targetTable, dbType: opts.dbType,
      mtId1: opts.mtId1, mtId2: opts.mtId2, details: opts.details
    });
  }
  return outcome;
}

/** Undo an import: every row it loaded, and its refused rows. See uploader.rollback for what it refuses. */
function rollback(opts, metaStore) {
  return uploader.rollback({
    movementId: opts.movementId,
    driver: drivers.db.getDriver(opts.dbType),
    connection: opts.dbConnection,
    targetTable: opts.targetTable,
    metaStore: metaStore
  });
}

/**
 * The rows an import dropped — refused by the database — from
 * `<table>_import_errors`, in the file's column order (`columns`, the
 * import's own record). An import made before refused rows were kept has
 * only its count: total 0.
 *
 * @returns {Promise<{ columns: string[], rows: [{ rowNum, reason, values }], total }>}
 */
async function droppedRows(opts) {
  var driver = drivers.db.getDriver(opts.dbType);
  var pool = await driver.connect(opts.dbConnection);
  try {
    var errTable = opts.targetTable + '_import_errors';
    var columns = (opts.columns || []).map(function(c) { return typeof c === 'string' ? c : c.name; })
      .filter(function(n) { return n && n.indexOf('__xeplr_') !== 0; });
    var schema = await driver.getTableSchema(pool, errTable);
    if (!schema || !schema.length) return { columns: columns, rows: [], total: 0 };

    var mark = require('@xeplr/actions/lib/drivers/db/procedure').placeholders(opts.dbType)(0);
    var t = driver.quoteIdent(errTable);
    var counted = await driver.query(pool, 'SELECT COUNT(*) AS n FROM ' + t + ' WHERE movement_id = ' + mark, [opts.movementId]);
    var total = Number(counted.rows[0].n || counted.rows[0].N || 0);

    var limit = Math.max(1, Math.min(Number(opts.limit) || DROPPED_VIEW_ROWS, DROPPED_FILE_ROWS));
    var top = opts.dbType === 'mssql' ? 'TOP (' + limit + ') ' : '';
    var tail = opts.dbType === 'mssql' ? '' : ' LIMIT ' + limit;
    var found = await driver.query(pool, 'SELECT ' + top + 'row_num, error_description, raw_row FROM ' + t +
      ' WHERE movement_id = ' + mark + ' ORDER BY row_num' + tail, [opts.movementId]);

    var rows = found.rows.map(function(r) {
      var values = r.raw_row;
      if (typeof values === 'string') { try { values = JSON.parse(values); } catch (_) { values = {}; } }
      values = values || {};
      // A value the import's record does not name is shown, not lost.
      Object.keys(values).forEach(function(k) { if (columns.indexOf(k) === -1) columns.push(k); });
      return { rowNum: r.row_num == null ? null : Number(r.row_num), reason: r.error_description || '', values: values };
    });
    return { columns: columns, rows: rows, total: total };
  } finally {
    await driver.close(pool);
  }
}

/**
 * droppedRows' answer as an .xlsx: the file's columns only, header in row 1,
 * no title — the shape an import reads, so the rows go back in once fixed.
 * The reason is not a column: it would be refused on the way back in.
 */
async function droppedRowsFile(found, outputPath) {
  var result = await runAction(builtins.exportTable, {
    format: 'xlsx',
    document: { columns: found.columns.map(function(c) { return { header: c }; }) },
    rows: found.rows.map(function(r) {
      return { values: found.columns.map(function(c) { return r.values[c] == null ? null : r.values[c]; }) };
    }),
    outputPath: outputPath
  });
  if (result.status !== 'success') throw new Error((result.error && result.error.message) || 'The file could not be written');
  return result.output.filePath;
}

/** How an import went in — 'new' | 'append' | 'replace', or null for one from before modes. */
function modeOf(job) {
  var meta = job && job.meta;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (e) { meta = null; } }
  return (meta && meta.mode) || null;
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

module.exports = {
  MODES: uploader.MODES,
  DROPPED_FILE_ROWS: DROPPED_FILE_ROWS,
  settings: settings,
  formatOf: formatOf,
  isWithin: isWithin,
  listSheets: listSheets,
  inspectChecks: inspectChecks,
  checkTarget: checkTarget,
  loadPart: loadPart,
  rollback: rollback,
  droppedRows: droppedRows,
  droppedRowsFile: droppedRowsFile,
  modeOf: modeOf
};
