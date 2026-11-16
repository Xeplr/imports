// A CHECK AND AN IMPORT RUN IN THE BACKGROUND. A 300 MB file takes minutes to
// load, and a check of a big CSV reads every row — far past any gateway's
// wait — so both answer at once with a run id, and the page follows the run.
//
// FROM ANY PROCESS. The run is an @xeplr/utils RunRegistry: the work and its
// stop switch stay in the process doing it; what it says about itself is kept
// in the RunStore every process reads (the app's own, or XEPLR_RUNS_STORE), so
// GET /runs/:id and ✕ work whichever of an app's processes answers them.
//
// HOW THE PAGE HEARS. Through the app's own event stream when it has one:
// `tell(userId, event)` (the router's `publish` option) is called as a run
// moves — at most once a second while it runs, and once when it ends, with
// the result — by the process doing the work. The event:
//
//   { type: 'import-run', runId, kind: 'check' | 'import', status, progress,
//     result, error }        status: running | complete | error | stopped
//
// The import's durable record is import_meta (written by @xeplr/actions'
// uploader before the first row), so a run lost with its process is still in
// the history, with its rows to roll back.

var { RunRegistry } = require('@xeplr/utils');

// A finished run is kept this long for its page to read the ending.
var KEEP_MS = 60 * 60 * 1000;

/**
 * The router's runs: start(work, { userId, kind, timeLimitMs }) → id,
 * view(id, userId), stop(id, userId, reason) — both async, from any process.
 */
function runsFor(store, tell) {
  var registry = new RunRegistry({ name: 'imports', store: store, idPrefix: 'imp_', keepMs: KEEP_MS });
  return {
    start: function(work, opts) {
      var noun = opts.kind === 'check' ? 'check' : 'import';
      return registry.start(work, {
        userId: opts.userId,
        kind: opts.kind,
        timeLimitMs: opts.timeLimitMs,
        timeLimitMessage: opts.timeLimitMs ? 'The ' + noun + ' took longer than ' + Math.round(opts.timeLimitMs / 60000) +
          ' minutes and was stopped.' : undefined,
        onChange: !tell || opts.userId == null ? null : function(view) {
          tell(String(opts.userId), {
            type: 'import-run', runId: view.id, kind: view.kind, status: view.status,
            progress: view.progress, result: view.result, error: view.error
          });
        }
      });
    },
    view: function(id, userId) { return registry.view(id, userId); },
    stop: function(id, userId, reason) { return registry.stop(id, userId, reason); }
  };
}

module.exports = runsFor;
