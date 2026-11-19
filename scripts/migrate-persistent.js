#!/usr/bin/env node
'use strict';

const { runPersistentMigration } = require('../library-migration-cli');

function parseArgs(argv) {
  let command = null;
  let configPath = null;
  let planHash = null;
  const commands = ['preflight', 'prepare', 'commit', 'abort'];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      configPath = argv[index + 1];
      index += 1;
      if (configPath === undefined) return { ok: false, code: 'config-required', error: 'An absolute --config path is required.' };
      continue;
    }
    if (arg === '--plan') {
      planHash = argv[index + 1];
      index += 1;
      if (planHash === undefined) return { ok: false, code: 'plan-required', error: 'Commit requires the plan hash printed by prepare.' };
      continue;
    }
    if (arg === '--root' || arg.startsWith('--root=') || arg === '--yes') {
      return { ok: false, code: 'invalid-command', error: 'The root comes from the authorization file. A yes flag cannot commit a plan.' };
    }
    if (commands.includes(arg) && !command) {
      command = arg;
      continue;
    }
    return { ok: false, code: 'invalid-command', error: 'Choose preflight, prepare, commit, or abort, plus --config.' };
  }
  if (!command) return { ok: false, code: 'invalid-command', error: 'Choose preflight, prepare, commit, or abort.' };
  if (!configPath) return { ok: false, code: 'config-required', error: 'An absolute --config path is required. The working directory is not used.' };
  return { ok: true, command, configPath, planHash };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stdout.write(`${JSON.stringify(parsed)}\n`);
    process.exit(1);
  }
  const result = runPersistentMigration({
    command: parsed.command,
    configPath: parsed.configPath,
    planHash: parsed.planHash,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result && result.ok ? 0 : 1);
}

main();
