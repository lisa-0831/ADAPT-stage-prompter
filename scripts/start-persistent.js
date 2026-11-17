#!/usr/bin/env node
'use strict';

const { bindAddress, startPersistentRuntime } = require('../server/persistent-runtime');

function fail(code, message) {
  process.stderr.write(`${JSON.stringify({ ok: false, code, error: message })}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  let configPath = null;
  let port = 3000;
  let bind = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      configPath = argv[index + 1];
      index += 1;
      if (configPath === undefined) fail('config-required', 'An absolute --config path is required.');
      continue;
    }
    if (arg === '--port') {
      port = Number(argv[index + 1]);
      index += 1;
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail('invalid-port', 'The port must be an integer from 0 through 65535.');
      continue;
    }
    if (arg === '--bind') {
      bind = argv[index + 1];
      index += 1;
      if (bind === undefined) fail('public-bind', 'A bind address is required when --bind is present.');
      continue;
    }
    fail('invalid-command', 'Use --config and, when needed, --port and --bind.');
  }
  if (!configPath) fail('config-required', 'An absolute --config path is required. The working directory is not used.');
  return { configPath, port, bindAddress: bindAddress(bind) };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const started = await startPersistentRuntime({
    configPath: parsed.configPath,
    port: parsed.port,
    bindAddress: parsed.bindAddress,
    staffToken: process.env.PROMPTER_STAFF_TOKEN || '',
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    host: started.host,
    port: started.server.address().port,
  })}\n`);
  await new Promise(() => {});
}

main().catch((err) => {
  fail(err && err.code ? err.code : 'startup-failed', err && err.message ? err.message : 'The persistent runtime did not start.');
});
