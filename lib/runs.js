// IMPORTS RUN IN THE BACKGROUND. A 300 MB file takes minutes to load, far
// past any gateway's timeout — so the commit answers at once with a run id.
// So does the check before it (inspect), which on a CSV reads every row.
//
// HOW THE PAGE HEARS. Through the app's own event stream when it has one:
// `tell(userId, event)` (the router's `publish` option) is called as a run
// moves — at most once a second while it runs, and once when it ends, with the
// result. GET /runs/:id answers too, for a page without the stream or while
// it is down. The event:
//
//   { type: 'import-run', runId, kind: 'check' | 'import', status, progress,
//     result, error }        status: running | complete | error | stopped
//
// Held in this process's memory: a run belongs to the process doing the work,
// and dies with it. The import's durable record is import_meta (written by
// @xeplr/actions' uploader before the first row), so a run lost to a restart
// is still in the history, with its rows to roll back.

var crypto = require('crypto');

// A finished run is kept this long for its page to read the ending, then gone.
var KEEP_FINISHED_MS = 60 * 60 * 1000;

// A running run is told to the stream at most this often.
var TELL_EVERY_MS = 1000;

var runs = new Map();

/**
 * Start `work(onProgress, signal)` in the background.
 *
 * @param {object} opts - { userId, kind?, timeLimitMs?, tell? }
 *   kind  'import' (the default) or 'check'
 *   tell  (userId, event) — the app's event stream, see above
 * @returns {string} the run id
 */
function startRun(work, opts) {
  opts = opts || {};
  var run = {
    id: 'imp_' + crypto.randomBytes(10).toString('hex'),
    userId: opts.userId == null ? null : String(opts.userId),
    kind: opts.kind || 'import',
    tell: typeof opts.tell === 'function' ? opts.tell : null,
    toldAt: 0,
    status: 'running',
    progress: null,
    result: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    controller: new AbortController(),
    timer: null
  };
  runs.set(run.id, run);

  if (opts.timeLimitMs) {
    run.timer = setTimeout(function() {
      stop(run.id, 'The ' + (run.kind === 'check' ? 'check' : 'import') + ' took longer than ' +
        Math.round(opts.timeLimitMs / 60000) + ' minutes and was stopped.');
    }, opts.timeLimitMs);
    if (run.timer.unref) run.timer.unref();
  }

  Promise.resolve().then(function() {
    return work(function(progress) {
      run.progress = progress;
      if (Date.now() - run.toldAt >= TELL_EVERY_MS) tell(run);
    }, run.controller.signal);
  }).then(function(result) {
    settle(run, run.controller.signal.aborted ? 'stopped' : 'complete', result, null);
  }, function(err) {
    settle(run, run.controller.signal.aborted ? 'stopped' : 'error', null, (err && err.message) || String(err));
  });
  return run.id;
}

function settle(run, status, result, error) {
  if (run.timer) clearTimeout(run.timer);
  run.status = status;
  run.result = result;
  run.error = status === 'stopped' ? (run.stopReason || 'Stopped') : error;
  run.finishedAt = Date.now();
  tell(run);
  var forget = setTimeout(function() { runs.delete(run.id); }, KEEP_FINISHED_MS);
  if (forget.unref) forget.unref();
}

/** The run, said to the app's stream. A failing stream never fails the run. */
function tell(run) {
  run.toldAt = Date.now();
  if (!run.tell || run.userId == null) return;
  try {
    run.tell(run.userId, {
      type: 'import-run', runId: run.id, kind: run.kind, status: run.status,
      progress: run.progress, result: run.result, error: run.error
    });
  } catch (e) { /* the page still has GET /runs/:id */ }
}

/** Ask a running import to stop: it stops reading within a batch. */
function stop(id, reason) {
  var run = runs.get(id);
  if (!run || run.status !== 'running') return false;
  run.stopReason = reason || 'Stopped';
  run.controller.abort();
  return true;
}

/**
 * A run as its page sees it — or null when there is none for this user. A
 * run is only ever shown to the person who started it.
 */
function view(id, userId) {
  var run = runs.get(id);
  if (!run || run.userId !== (userId == null ? null : String(userId))) return null;
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    progress: run.progress,
    result: run.result,
    error: run.error,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt
  };
}

module.exports = { startRun: startRun, stop: stop, view: view };
