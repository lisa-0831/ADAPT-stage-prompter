'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { runSetup, listLegacyFiles } = require('../scripts/setup');
const { defaultHome, protectedRoots, REPO_ROOT } = require('../scripts/install-paths');
const { detectStorageMode } = require('../server/storage-mode');

const LIVE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const LIVE_TEXT = '# Live Show\n[ADA]\nFIRST CUE\n';
const OTHER_TEXT = '# Saved Show\n[ADA]\nSECOND CUE\n';
const WELCOME = '2d0f0937-fc36-4d27-a31e-d047c2fd5623';
const INDEX_LIVE = 'ee04e849-90d4-4eeb-b2a6-562b06067a32';

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function makeParent(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.adapt-setup-test-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return parent;
}

function writeSeed(root) {
  const library = path.join(root, 'data', 'library', 'scripts');
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(library, `${LIVE}.txt`), LIVE_TEXT);
  fs.writeFileSync(path.join(library, `${OTHER}.txt`), OTHER_TEXT);
  fs.writeFileSync(path.join(root, 'script.txt'), LIVE_TEXT);
  fs.writeFileSync(path.join(root, 'script.previous.txt'), 'previous-live\n');
  writeJson(path.join(root, 'script.previous.txt.meta.json'), { liveId: null, textHash: 'ab'.repeat(32) });
  writeJson(path.join(root, 'data', 'library', 'index.json'), {
    version: 1,
    liveId: OTHER,
    scripts: [
      { id: LIVE, title: 'Live Show', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revision: 'aa'.repeat(32) },
      { id: OTHER, title: 'Saved Show', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revision: 'bb'.repeat(32) },
    ],
  });
}

function entryCount(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).length;
}

function request(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: route,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch (err) { /* Text responses stay strings. */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function firstJson(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`timed out\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout.slice(0, newline)));
      } catch (err) {
        reject(err);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => {
      if (stdout.indexOf('\n') >= 0) return;
      clearTimeout(timer);
      reject(new Error(`exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 8000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGINT');
  });
}

test('the default directory is outside the checkout and the live data directory', () => {
  const home = defaultHome({});
  const data = path.join(home, 'library');
  assert.equal(data.includes(`${path.sep}ADAPT-stage-prompter-data`), false);
  protectedRoots().forEach((root) => {
    const relative = path.relative(root, data);
    assert.equal(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)), false);
  });
  const repoRelative = path.relative(REPO_ROOT, data);
  assert.notEqual(repoRelative, '');
  assert.ok(repoRelative.startsWith('..') || path.isAbsolute(repoRelative));
});

test('setup refuses the development live directories without changing them', () => {
  const counts = new Map(protectedRoots().map((root) => [root, entryCount(root)]));
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.adapt-setup-guard-')));
  try {
    writeSeed(path.join(parent, 'seed'));
    protectedRoots().forEach((root) => {
      const result = runSetup({
        repoRoot: path.join(parent, 'seed'),
        dataRoot: root,
        configDir: path.join(parent, 'config'),
        backupDir: path.join(parent, 'backup'),
        env: {},
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'protected-path');
      assert.equal(entryCount(root), counts.get(root));
    });
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('setup migrates a fixture once and a second run does not replace it', (t) => {
  const parent = makeParent(t);
  const seed = path.join(parent, 'seed');
  const home = path.join(parent, 'home');
  writeSeed(seed);
  const first = runSetup({ repoRoot: seed, home, env: {} });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.alreadyInstalled, false);
  assert.equal(first.productionId, LIVE);
  assert.notEqual(first.productionId, OTHER);
  const marker = fs.readFileSync(path.join(home, 'library', 'data', 'library', 'migration.json'));
  const savedScript = fs.readFileSync(path.join(seed, 'script.txt'));
  const second = runSetup({ repoRoot: seed, home, env: {} });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.alreadyInstalled, true);
  assert.equal(second.migrationId, first.migrationId);
  assert.equal(fs.readFileSync(path.join(home, 'library', 'data', 'library', 'migration.json')).equals(marker), true);
  assert.equal(fs.readFileSync(path.join(seed, 'script.txt')).equals(savedScript), true);
  assert.equal(detectStorageMode({ libraryDir: path.join(seed, 'data', 'library') }).mode, 'legacy');
  const mode = fs.statSync(path.join(home, 'config', 'runtime-authorization.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('setup fails when the destination already has files', (t) => {
  const parent = makeParent(t);
  const seed = path.join(parent, 'seed');
  const home = path.join(parent, 'home');
  writeSeed(seed);
  const library = path.join(home, 'library');
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(library, 'keep.txt'), 'leave this file\n');
  const result = runSetup({ repoRoot: seed, home, env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'destination-not-empty');
  assert.equal(fs.readFileSync(path.join(library, 'keep.txt'), 'utf8'), 'leave this file\n');
  assert.equal(fs.existsSync(path.join(library, 'data', 'library', 'migration.json')), false);
});

test('setup fails when the repository seed is missing', (t) => {
  const parent = makeParent(t);
  const seed = path.join(parent, 'seed');
  fs.mkdirSync(seed);
  fs.writeFileSync(path.join(seed, 'script.txt'), LIVE_TEXT);
  const result = runSetup({ repoRoot: seed, home: path.join(parent, 'home'), env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing-legacy');
  assert.equal(fs.existsSync(path.join(parent, 'home', 'library')), false);
});

test('npm start fails closed when setup has not been run', async (t) => {
  const parent = makeParent(t);
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts', 'start-installed.js')], {
    env: Object.assign({}, process.env, {
      ADAPT_PROMPTER_HOME: path.join(parent, 'home'),
      ADAPT_PROMPTER_DATA: '',
      ADAPT_PROMPTER_CONFIG: '',
      ADAPT_PROMPTER_BACKUP: '',
      PORT: '0',
      PROMPTER_STAFF_TOKEN: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 1);
  const parsed = JSON.parse(stderr);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'config-required');
  assert.match(parsed.error, /npm run setup/);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'data', 'library', 'migration.json')), false);
});

test('a fresh clone of the repository seed installs, saves, and restarts', async (t) => {
  const parent = makeParent(t);
  const clone = path.join(parent, 'clone');
  const home = path.join(parent, 'home');
  const listed = listLegacyFiles(REPO_ROOT);
  assert.equal(listed.ok, true, listed.error);
  listed.files.forEach((relative) => {
    const from = path.join(REPO_ROOT, ...relative.split('/'));
    const to = path.join(clone, ...relative.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  });
  const before = new Map(listed.files.map((relative) => [relative, sha256(path.join(REPO_ROOT, ...relative.split('/')))]));
  const liveCounts = new Map(protectedRoots().map((root) => [root, entryCount(root)]));
  const installed = runSetup({ repoRoot: clone, home, env: {} });
  assert.equal(installed.ok, true, installed.error);
  assert.equal(installed.productionId, WELCOME);
  assert.notEqual(installed.productionId, INDEX_LIVE);
  assert.equal(fs.existsSync(path.join(home, 'backups', 'legacy-before-migration', 'backup-manifest.json')), true);
  assert.equal(fs.existsSync(path.join(home, 'backups', '.adapt-restore-check')), false);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'data', 'library', 'migration.json')), false);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'data', 'library', '.writer.lock')), false);

  const env = Object.assign({}, process.env, {
    ADAPT_PROMPTER_HOME: home,
    ADAPT_PROMPTER_DATA: '',
    ADAPT_PROMPTER_CONFIG: '',
    ADAPT_PROMPTER_BACKUP: '',
    PORT: '0',
    PROMPTER_STAFF_TOKEN: '',
  });
  const starter = path.join(REPO_ROOT, 'scripts', 'start-installed.js');
  const first = spawn(process.execPath, [starter], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => stopChild(first));
  const firstReady = await firstJson(first, 60000);
  assert.equal(firstReady.ok, true);
  assert.equal(firstReady.host, '127.0.0.1');
  const live = await request(firstReady.port, 'GET', '/script');
  assert.equal(live.status, 200);
  assert.ok(live.raw.length > 100);
  const title = `Setup persistence ${crypto.randomBytes(4).toString('hex')}`;
  const created = await request(firstReady.port, 'POST', '/api/library', JSON.stringify({
    title,
    text: '# Setup Check\n[ADA]\nSAVED AFTER RESTART\n',
  }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const createdId = created.body.script.id;
  await stopChild(first);

  const second = spawn(process.execPath, [starter], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => stopChild(second));
  const secondReady = await firstJson(second, 60000);
  assert.equal(secondReady.ok, true);
  const listedAfter = await request(secondReady.port, 'GET', '/api/library');
  assert.equal(listedAfter.status, 200);
  assert.ok(listedAfter.body.scripts.some((script) => script.id === createdId && script.title === title));
  const again = runSetup({ repoRoot: clone, home, env: {} });
  assert.equal(again.ok, true, again.error);
  assert.equal(again.alreadyInstalled, true);
  assert.equal(again.migrationId, installed.migrationId);
  const stillThere = await request(secondReady.port, 'GET', '/api/library');
  assert.ok(stillThere.body.scripts.some((script) => script.id === createdId));
  await stopChild(second);

  const third = spawn(process.execPath, [starter], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => stopChild(third));
  const thirdReady = await firstJson(third, 60000);
  const afterRestart = await request(thirdReady.port, 'GET', '/api/library');
  assert.ok(afterRestart.body.scripts.some((script) => script.id === createdId && script.title === title));
  await stopChild(third);

  before.forEach((hash, relative) => {
    assert.equal(sha256(path.join(REPO_ROOT, ...relative.split('/'))), hash);
  });
  protectedRoots().forEach((root) => {
    assert.equal(entryCount(root), liveCounts.get(root));
  });
});
