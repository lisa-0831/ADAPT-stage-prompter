#!/usr/bin/env node
'use strict';

const { startPersistentRuntime } = require('../server/persistent-runtime');
const { resolveInstallPaths } = require('./install-paths');
const { ensureVersionedInstall } = require('./versioned-seed');

// Starts the Versioned Library. The first start copies the committed seed
// into durable storage and writes the local authorization there. A later
// start reuses that library. This command does not migrate Legacy text,
// does not open the checkout as the live library, and listens on loopback.

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
  const installed = ensureVersionedInstall(paths);
  if (!installed.ok) fail(installed.code, installed.error);
  return paths.runtimeConfigPath;
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
