#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { startPersistentRuntime } = require('../server/persistent-runtime');
const { resolveInstallPaths } = require('./install-paths');

// Starts the installed Versioned Library. A missing authorization file is
// a failed start. This command does not open the Legacy seed in the checkout
// and it does not listen on every interface.

function fail(code, message) {
  process.stderr.write(`${JSON.stringify({ ok: false, code, error: message })}\n`);
  process.exit(1);
}

function portFromEnv(env) {
  if (env.PORT === undefined || env.PORT === '') return 3000;
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail('invalid-port', 'PORT must be an integer from 0 through 65535.');
  }
  return port;
}

function configPathFromEnv(env) {
  const paths = resolveInstallPaths({ env });
  if (!paths.ok) fail(paths.code, paths.error);
  let stat;
  try {
    stat = fs.lstatSync(paths.runtimeConfigPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      fail(
        'config-required',
        'The Versioned Library is not installed. Run npm run setup first. This command does not open the Legacy library in the checkout.',
      );
    }
    fail('config-invalid', 'The runtime authorization could not be read.');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('config-invalid', 'The runtime authorization must be a regular file.');
  }
  const resolved = fs.realpathSync(paths.runtimeConfigPath);
  if (resolved !== path.resolve(paths.runtimeConfigPath)) {
    fail('config-invalid', 'The runtime authorization path must already be canonical.');
  }
  return resolved;
}

async function main() {
  const configPath = configPathFromEnv(process.env);
  const started = await startPersistentRuntime({
    configPath,
    port: portFromEnv(process.env),
    bindAddress: '127.0.0.1',
    staffToken: process.env.PROMPTER_STAFF_TOKEN || '',
  });
  const port = started.server.address().port;
  process.stdout.write(`${JSON.stringify({ ok: true, host: '127.0.0.1', port })}\n`);
  process.stdout.write(`Controller: http://127.0.0.1:${port}/?role=controller\n`);
  process.stdout.write(`Actor:      http://127.0.0.1:${port}/?role=actor\n`);
  process.stdout.write(`Audience:   http://127.0.0.1:${port}/?role=audience\n`);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    Promise.resolve(started.close()).then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function run() {
  return main().catch((err) => {
    fail(err && err.code ? err.code : 'startup-failed', err && err.message ? err.message : 'The installed library did not start.');
  });
}

if (require.main === module) run();

module.exports = {
  configPathFromEnv,
  portFromEnv,
  run,
};
