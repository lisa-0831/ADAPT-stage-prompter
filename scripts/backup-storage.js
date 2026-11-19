#!/usr/bin/env node
'use strict';

const {
  createStorageBackup,
  verifyStorageBackup,
  restoreStorageBackup,
} = require('../server/storage-backup');

const COMMANDS = ['create', 'verify', 'restore'];

function parseArgs(argv) {
  let command = null;
  let sourceRoot = null;
  let backupDir = null;
  let destinationRoot = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') {
      sourceRoot = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--dest') {
      backupDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--restore-to') {
      destinationRoot = argv[index + 1];
      index += 1;
      continue;
    }
    if (COMMANDS.includes(arg) && !command) {
      command = arg;
      continue;
    }
    return { ok: false, code: 'invalid-command', error: 'Use create, verify, or restore with absolute paths.' };
  }
  if (!command) return { ok: false, code: 'invalid-command', error: 'Choose create, verify, or restore.' };
  return { ok: true, command, sourceRoot, backupDir, destinationRoot };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stdout.write(`${JSON.stringify(parsed)}\n`);
    process.exit(1);
  }
  let result;
  if (parsed.command === 'create') result = createStorageBackup(parsed);
  else if (parsed.command === 'verify') result = verifyStorageBackup(parsed);
  else result = restoreStorageBackup(parsed);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result && result.ok ? 0 : 1);
}

main();
