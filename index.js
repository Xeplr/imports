// @xeplr/imports — data imports as a drop-in module. See README.md.
//
//   var imports = require('@xeplr/imports');
//   router.use('/imports', imports.router({ auth, resolveTarget, listTargets, service: 'my-app' }));
//
// plus `imports.requiredEnv` in the app's env.required.js and
// `imports.authMigrationsDir` in XEPLR_AUTH_MIGRATIONS.

var path = require('path');
var actions = require('@xeplr/actions');
var { requiredEnv: configRequiredEnv } = require('@xeplr/actions/lib/uploader/attach');

// What this package needs from the environment, for the app's checkEnv.
// XEPLR_DATA_DIR (@xeplr/actions): uploads are staged in each tenant's own
// uploads/ under it — absolute, never defaulted (a wrong-but-present location
// reads as "no file", not as an error). The import records live in
// xeplr_configs (XCFG_DB_NAME, and the login in XCFG_DB_CONNECTION_INFO_ENCRYPTED
// or the shared XEPLR_DB_CONNECTION).
var requiredEnv = actions.requiredEnv.concat(configRequiredEnv);

module.exports = {
  router: require('./lib/router'),
  requiredEnv: requiredEnv,
  // This package's access catalog (apis, role mappings) — add it to the app's
  // XEPLR_AUTH_MIGRATIONS so its auth database knows these routes.
  authMigrationsDir: path.join(__dirname, 'migrations-auth'),
  MODES: require('./lib/imports').MODES
};
