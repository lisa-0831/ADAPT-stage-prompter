#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { startPersistentRuntime } = require('../server/persistent-runtime');

const CONFIG_PATH = path.join(os.homedir(), 'ADAPT-stage-prompter-config', 'runtime-authorization.json');

function fail(code, message) {
  process.stderr.write(`${JSON.stringify({ ok: false, code, error: message })}\n`);
  process.exit(1);
}

function portFromEnv() {
  if (process.env.PORT === undefined || process.env.PORT === '') return 3000;
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail('invalid-port', 'PORT must be an integer from 1 through 65535.');
  }
  return port;
}

function localConfigPath() {
  let stat;
  try {
    stat = fs.lstatSync(CONFIG_PATH);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      fail('config-required', `The local runtime authorization is missing: ${CONFIG_PATH}`);
    }
    fail('config-invalid', 'The local runtime authorization could not be read.');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('config-invalid', 'The local runtime authorization must be a regular file.');
  }
  const resolved = fs.realpathSync(CONFIG_PATH);
  if (resolved !== path.resolve(CONFIG_PATH)) {
    fail('config-invalid', 'The local runtime authorization path must already be canonical.');
  }
  const repo = fs.realpathSync(path.join(__dirname, '..'));
  if (resolved === repo || resolved.startsWith(`${repo}${path.sep}`)) {
    fail('unsafe-root', 'The runtime authorization must stay outside this Git checkout.');
  }
  return resolved;
}

async function main() {
  const started = await startPersistentRuntime({
    configPath: localConfigPath(),
    port: portFromEnv(),
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

main().catch((err) => {
  fail(err && err.code ? err.code : 'startup-failed', err && err.message ? err.message : 'The persistent runtime did not start.');
});
