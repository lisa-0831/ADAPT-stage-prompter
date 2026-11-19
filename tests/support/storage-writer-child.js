'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const { createPrompterServer } = require(path.join(REPO, 'server'));
const { installVersionedLive } = require(path.join(REPO, 'server/versioned-live-install'));
const { createVersionStore } = require(path.join(REPO, 'library-version-store'));
const { runMigration } = require(path.join(REPO, 'library-migration-cli'));
const { beginPersistentMigration } = require(path.join(REPO, 'server/persistent-authorization'));
const { authorizeVersionedFixture } = require(path.join(REPO, 'server/versioned-runtime'));
const { authorizeVersionedPersistentRoot } = require(path.join(REPO, 'server/persistent-authorization'));

function readPayload() {
  return JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
}

function finish(line) {
  process.stdout.write(`${line}\n`);
}

async function boot() {
  const payload = readPayload();
  const options = {
    scriptFile: payload.scriptFile,
    previousFile: payload.previousFile,
    libraryDir: payload.libraryDir,
    journalDir: payload.journalDir,
    staffToken: 'child-staff',
  };
  if (payload.mode === 'persistent') {
    options.persistentRoot = authorizeVersionedPersistentRoot({ configPath: payload.configPath });
  } else {
    options.versionedFixture = authorizeVersionedFixture(payload);
  }
  const server = await createPrompterServer(options);
  await new Promise((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  finish(`LISTENING ${server.server.address().port}`);
  await new Promise((resolve) => {
    process.stdin.on('end', resolve);
    process.stdin.resume();
  });
  await server.close();
}

async function main() {
  const command = process.argv[2];
  if (command === 'hold') {
    const { acquireStorageWriter } = require(path.join(REPO, 'server/storage-writer-lock'));
    const hold = acquireStorageWriter(process.argv[3]);
    finish(`READY ${hold.libraryReal}`);
    await new Promise((resolve) => {
      process.stdin.on('end', resolve);
      process.stdin.resume();
    });
    hold.release();
    return;
  }
  if (command === 'boot') {
    await boot();
    return;
  }
  if (command === 'install') {
    const result = installVersionedLive(readPayload());
    finish(`RESULT ${result && result.ok === true ? 'ok' : result.code}`);
    return;
  }
  if (command === 'save') {
    const payload = readPayload();
    const store = createVersionStore({ root: payload.libraryDir });
    const saved = await store.saveVersion(payload.input);
    finish(`RESULT ${saved && saved.ok === true ? 'ok' : saved.code}`);
    return;
  }
  if (command === 'prepare') {
    const result = runMigration({ command: 'prepare', root: process.argv[3] });
    finish(`RESULT ${result && result.ok === true ? 'ok' : result.code}`);
    return;
  }
  if (command === 'migrate') {
    try {
      const claim = beginPersistentMigration({ configPath: process.argv[3] });
      finish(`RESULT ${claim.ok === true ? 'ok' : claim.code}`);
      if (claim.release) claim.release();
    } catch (err) {
      finish(`RESULT ${err.code || 'error'}`);
    }
    return;
  }
  finish('RESULT unknown-command');
  process.exit(2);
}

main().catch((err) => {
  finish(`REFUSED ${err && err.code ? err.code : 'error'}`);
  process.exit(2);
});
