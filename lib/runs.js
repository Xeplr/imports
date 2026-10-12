// IMPORTS RUN IN THE BACKGROUND. A 300 MB file takes minutes to load, far
// past any gateway's timeout — so the commit answers at once with a run id,
// and the page asks how far it has got (GET /runs/:id) until it ends.
//
// Held in this process's memory: a run belongs to the process doing the work,
// and dies with it. The import's durable record is import_meta (written by
// @xeplr/actions' uploader before the first row), so a run lost to a restart
// is still in the history, with its rows to roll back.

var crypto = require('crypto');

// A finished run is kept this long for its page to read the ending, then gone.
var KEEP_FINISHED_MS = 60 * 60 * 1000;

var runs = new Map();

/**
 * Start `work(onProgress, signal)` in the background.
 *
 * @param {object} opts - { userId, timeLimitMs? }
 * @returns {string} the run id
 */
function startRun(work, opts) {
  opts = opts || {};
  var run = {
    id: 'imp_' + crypto.randomBytes(10).toString('hex'),
    userId: opts.userId == null ? null : String(opts.userId),
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
      stop(run.id, 'The import took longer than ' + Math.round(opts.timeLimitMs / 60000) + ' minutes and was stopped.');
    }, opts.timeLimitMs);
    if (run.timer.unref) run.timer.unref();
  }

  Promise.resolve().then(function() {
    return work(function(progress) { run.progress = progress; }, run.controller.signal);
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
  var forget = setTimeout(function() { runs.delete(run.id); }, KEEP_FINISHED_MS);
  if (forget.unref) forget.unref();
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
    status: run.status,
    progress: run.progress,
    result: run.result,
    error: run.error,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt
  };
}

module.exports = { startRun: startRun, stop: stop, view: view };
