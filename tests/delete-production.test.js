const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');

const { createVersionedLibraryService } = require('../server/versioned-library-service');
const { registerVersionedHttpRoutes } = require('../server/versioned-http-routes');
const { createPrompterServer } = require('../server');
const { authorizeVersionedFixture } = require('../server/versioned-runtime');
const { ensureVersionedInstall, WELCOME_ID } = require('../scripts/versioned-seed');
const { resolveInstallPaths } = require('../scripts/install-paths');
const { assertCheckoutSeedIntact } = require('./support/checkout-seed');

const REPO = path.resolve(__dirname, '..');
const LIVE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const EXTRA = '33333333-3333-4333-8333-333333333333';
const LIVE_VERSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const OTHER_VERSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const OTHER_NEXT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const ASSET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const MIGRATION = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const NOW = '2026-06-06T00:00:00.000Z';
const CREATED = '2026-06-06T01:00:00.000Z';
const LIVE_TEXT = '# Opening\n[ADA]\nLIVE LINE\n';
const OTHER_TEXT = '# Hamlet\n[ADA]\nSAVED LINE\n';
const OTHER_NEXT_TEXT = '# Hamlet\n[ADA]\nSECOND VERSION\n';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function makeRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-delete-production-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function openService(t, root) {
  const libraryDir = path.join(root, 'data', 'library');
  const journalDir = path.join(root, 'data', 'live-journal');
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.mkdirSync(journalDir, { recursive: true });
  const scriptFile = path.join(root, 'script.txt');
  const previousFile = path.join(root, 'script.previous.txt');
  if (!fs.existsSync(scriptFile)) fs.writeFileSync(scriptFile, LIVE_TEXT);
  if (!fs.existsSync(previousFile)) fs.writeFileSync(previousFile, 'previous-live\n');
  if (!fs.existsSync(`${previousFile}.meta.json`)) {
    writeJson(`${previousFile}.meta.json`, { liveId: null, textHash: 'ab'.repeat(32) });
  }
  const service = createVersionedLibraryService({
    root,
    libraryDir,
    scriptFile,
    journalDir,
    now: () => NOW,
  });
  assert.equal(service.ok, true, service.error);
  t.after(() => service.close());
  return { root, libraryDir, scriptFile, previousFile, journalDir, service };
}

function treeHashes(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  function walk(current, prefix) {
    fs.readdirSync(current).forEach((name) => {
      const full = path.join(current, name);
      const stat = fs.lstatSync(full);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (stat.isSymbolicLink()) {
        out[rel] = `link:${fs.readlinkSync(full)}`;
        return;
      }
      if (stat.isDirectory()) {
        walk(full, rel);
        return;
      }
      out[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    });
  }
  walk(dir, '');
  return out;
}

async function createShow(service, productionId, versionId, title, text) {
  const created = await service.createProduction({
    productionId,
    versionId,
    title,
    text,
    createdAt: CREATED,
  });
  assert.equal(created.ok, true, created.error);
  return created;
}

function contentHash(fixture, productionId, versionId) {
  const version = JSON.parse(fs.readFileSync(path.join(
    fixture.libraryDir, 'productions', productionId, 'versions', versionId, 'version.json',
  ), 'utf8'));
  return version.contentHash;
}

function installLive(fixture, previous) {
  const liveHash = contentHash(fixture, LIVE, LIVE_VERSION);
  const text = fs.readFileSync(path.join(
    fixture.libraryDir, 'productions', LIVE, 'versions', LIVE_VERSION, 'script.txt',
  ));
  const state = {
    schema: 1,
    productionId: LIVE,
    versionId: LIVE_VERSION,
    contentHash: liveHash,
    previousActivation: previous,
    updatedAt: NOW,
    generation: 2,
  };
  writeJson(path.join(fixture.libraryDir, 'migration.json'), {
    schema: 2,
    state: 'committed',
    migrationId: MIGRATION,
    productionId: LIVE,
    versionId: LIVE_VERSION,
    sourceScriptHash: liveHash,
    contentHash: liveHash,
    mirrorInstalled: true,
    previousActivation: null,
  });
  writeJson(path.join(fixture.libraryDir, 'live-state.json'), state);
  fs.writeFileSync(fixture.scriptFile, text);
  return { liveHash, marker: fs.readFileSync(path.join(fixture.libraryDir, 'migration.json')) };
}

async function prepareLibrary(t) {
  const fixture = openService(t, makeRoot(t));
  await createShow(fixture.service, LIVE, LIVE_VERSION, 'Opening', LIVE_TEXT);
  await createShow(fixture.service, OTHER, OTHER_VERSION, 'Hamlet', OTHER_TEXT);
  const saved = await fixture.service.saveVersion({
    productionId: OTHER,
    expectedVersionId: OTHER_VERSION,
    newVersionId: OTHER_NEXT,
    text: OTHER_NEXT_TEXT,
    createdAt: '2026-06-06T02:00:00.000Z',
  });
  assert.equal(saved.ok, true, saved.error);
  const uploaded = await fixture.service.uploadAsset({
    productionId: OTHER,
    assetId: ASSET,
    name: 'scene.png',
    body: PNG,
  });
  assert.equal(uploaded.ok, true, uploaded.error);
  const shared = path.join(fixture.root, 'images', 'Title_Card.jpeg');
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  fs.writeFileSync(shared, PNG);
  const assets = path.join(fixture.libraryDir, 'productions', OTHER, 'assets');
  fs.symlinkSync(shared, path.join(assets, 'shared-link'));
  fs.linkSync(shared, path.join(assets, 'hard-link.png'));
  fs.mkdirSync(path.join(fixture.libraryDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(fixture.libraryDir, 'scripts', `${OTHER}.txt`), OTHER_NEXT_TEXT);
  fs.writeFileSync(path.join(fixture.libraryDir, 'scripts', `${LIVE}.txt`), LIVE_TEXT);
  writeJson(path.join(fixture.libraryDir, 'index.json'), {
    version: 1,
    liveId: LIVE,
    scripts: [
      { id: LIVE, title: 'Opening' },
      { id: OTHER, title: 'Hamlet' },
    ],
  });
  const previous = {
    productionId: OTHER,
    versionId: OTHER_NEXT,
    contentHash: contentHash(fixture, OTHER, OTHER_NEXT),
  };
  const installed = installLive(fixture, previous);
  fixture.shared = shared;
  fixture.markerBytes = installed.marker;
  fixture.mirrorBytes = fs.readFileSync(fixture.scriptFile);
  fixture.previousBytes = fs.readFileSync(fixture.previousFile);
  fixture.liveTree = treeHashes(path.join(fixture.libraryDir, 'productions', LIVE));
  return fixture;
}

function productionNames(fixture) {
  return fs.readdirSync(path.join(fixture.libraryDir, 'productions'))
    .filter((name) => !name.startsWith('.'))
    .sort();
}

test('delete removes one production and leaves the live show and other files', async (t) => {
  const fixture = await prepareLibrary(t);
  const refused = await fixture.service.deleteProduction({
    productionId: LIVE,
    expectedGeneration: 1,
    expectedRevision: contentHash(fixture, LIVE, LIVE_VERSION),
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'live-production');
  assert.equal(productionNames(fixture).includes(LIVE), true);

  const stale = await fixture.service.deleteProduction({
    productionId: OTHER,
    expectedGeneration: 1,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'conflict');
  assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'productions', OTHER, 'versions', OTHER_VERSION)), true);

  const removed = await fixture.service.deleteProduction({
    productionId: OTHER,
    expectedGeneration: 2,
    expectedRevision: contentHash(fixture, OTHER, OTHER_NEXT),
  });
  assert.equal(removed.ok, true, removed.error);
  assert.equal(removed.deleted, true);
  assert.equal(removed.previousActivationCleared, true);
  assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'productions', OTHER)), false);
  assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'scripts', `${OTHER}.txt`)), false);
  assert.deepEqual(productionNames(fixture), [LIVE]);
  assert.deepEqual(treeHashes(path.join(fixture.libraryDir, 'productions', LIVE)), fixture.liveTree);
  assert.equal(fs.existsSync(fixture.shared), true);
  assert.equal(hashFile(fixture.shared), crypto.createHash('sha256').update(PNG).digest('hex'));
  assert.equal(fs.readFileSync(path.join(fixture.libraryDir, 'migration.json')).equals(fixture.markerBytes), true);
  assert.equal(fs.readFileSync(fixture.scriptFile).equals(fixture.mirrorBytes), true);
  assert.equal(fs.readFileSync(fixture.previousFile).equals(fixture.previousBytes), true);
  const liveState = JSON.parse(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'), 'utf8'));
  assert.equal(liveState.productionId, LIVE);
  assert.equal(liveState.versionId, LIVE_VERSION);
  assert.equal(liveState.generation, 2);
  assert.equal(liveState.previousActivation, null);
  const index = JSON.parse(fs.readFileSync(path.join(fixture.libraryDir, 'index.json'), 'utf8'));
  assert.equal(index.liveId, LIVE);
  assert.deepEqual(index.scripts.map((entry) => entry.id), [LIVE]);
  assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'scripts', `${LIVE}.txt`)), true);

  const listed = await fixture.service.listProductions();
  assert.equal(listed.ok, true, listed.error);
  assert.deepEqual(listed.productions.map((entry) => entry.productionId), [LIVE]);
  assert.equal(listed.productions[0].live, true);
  const missing = await fixture.service.readProductionDetail(OTHER);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'missing-production');

  await fixture.service.close();
  const reopened = createVersionedLibraryService({
    root: fixture.root,
    libraryDir: fixture.libraryDir,
    scriptFile: fixture.scriptFile,
    journalDir: fixture.journalDir,
    now: () => NOW,
  });
  t.after(() => reopened.close());
  const afterRestart = await reopened.listProductions();
  assert.deepEqual(afterRestart.productions.map((entry) => entry.productionId), [LIVE]);
  assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'productions', OTHER)), false);
  assertCheckoutSeedIntact(REPO);
});

test('a failed delete does not corrupt the other production', async (t) => {
  const fixture = await prepareLibrary(t);
  const before = treeHashes(path.join(fixture.libraryDir, 'productions', OTHER));
  const rolled = await fixture.service.deleteProduction({
    productionId: OTHER,
    expectedGeneration: 2,
    failAt: 'after-rename',
  });
  assert.equal(rolled.ok, false);
  assert.equal(rolled.code, 'storage-failure');
  assert.deepEqual(treeHashes(path.join(fixture.libraryDir, 'productions', OTHER)), before);
  const liveState = JSON.parse(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'), 'utf8'));
  assert.equal(liveState.previousActivation.productionId, OTHER);
  assert.deepEqual(treeHashes(path.join(fixture.libraryDir, 'productions', LIVE)), fixture.liveTree);

  const partial = await fixture.service.deleteProduction({
    productionId: OTHER,
    expectedGeneration: 2,
    failAt: 'after-first-unlink',
  });
  assert.equal(partial.ok, false);
  assert.equal(partial.code, 'delete-incomplete');
  assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'productions', OTHER)), false);
  assert.deepEqual(treeHashes(path.join(fixture.libraryDir, 'productions', LIVE)), fixture.liveTree);
  assert.equal(fs.readFileSync(fixture.scriptFile).equals(fixture.mirrorBytes), true);
  assert.equal(fs.existsSync(fixture.shared), true);
  const listed = await fixture.service.listProductions();
  assert.deepEqual(listed.productions.map((entry) => entry.productionId), [LIVE]);
  const again = await fixture.service.deleteProduction({ productionId: OTHER, expectedGeneration: 2 });
  assert.equal(again.code, 'missing-production');
});

test('an unfinished live journal blocks deletion', async (t) => {
  const fixture = await prepareLibrary(t);
  const pending = path.join(fixture.journalDir, 'versioned-live', 'pending');
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, 'plan.json'), '{}\n');
  const blocked = await fixture.service.deleteProduction({
    productionId: OTHER,
    expectedGeneration: 2,
  });
  assert.equal(blocked.code, 'journal-conflict');
  assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'productions', OTHER, 'metadata.json')), true);
  fs.unlinkSync(path.join(pending, 'plan.json'));
  const removed = await fixture.service.deleteProduction({
    productionId: OTHER,
    expectedGeneration: 2,
  });
  assert.equal(removed.ok, true, removed.error);
});

test('concurrent deletes do not remove another production', async (t) => {
  const fixture = await prepareLibrary(t);
  await createShow(fixture.service, EXTRA, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', 'Macbeth', '# Macbeth\n[ADA]\nTHIRD\n');
  const liveBefore = treeHashes(path.join(fixture.libraryDir, 'productions', LIVE));
  const [first, second] = await Promise.all([
    fixture.service.deleteProduction({ productionId: OTHER, expectedGeneration: 2 }),
    fixture.service.deleteProduction({ productionId: OTHER, expectedGeneration: 2 }),
  ]);
  const results = [first, second].sort((left, right) => Number(Boolean(right.ok)) - Number(Boolean(left.ok)));
  assert.equal(results[0].ok, true, results[0].error);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].code, 'missing-production');
  const extra = await fixture.service.deleteProduction({ productionId: EXTRA, expectedGeneration: 1 });
  assert.equal(extra.ok, true, extra.error);
  assert.deepEqual(productionNames(fixture), [LIVE]);
  assert.deepEqual(treeHashes(path.join(fixture.libraryDir, 'productions', LIVE)), liveBefore);
  const liveDelete = await fixture.service.deleteProduction({ productionId: LIVE, expectedGeneration: 1 });
  assert.equal(liveDelete.code, 'live-production');
});

test('delete survives a full server stop and restart', async (t) => {
  const fixture = await prepareLibrary(t);
  await fixture.service.close();
  async function boot() {
    const server = await createPrompterServer({
      scriptFile: fixture.scriptFile,
      previousFile: fixture.previousFile,
      libraryDir: fixture.libraryDir,
      journalDir: fixture.journalDir,
      staffToken: 'stage-staff',
      versionedFixture: authorizeVersionedFixture({
        root: fixture.root,
        libraryDir: fixture.libraryDir,
        scriptFile: fixture.scriptFile,
        previousFile: fixture.previousFile,
        journalDir: fixture.journalDir,
      }),
      now: () => NOW,
    });
    await new Promise((resolve, reject) => {
      server.server.once('error', reject);
      server.server.listen(0, '127.0.0.1', resolve);
    });
    return server;
  }
  let current = await boot();
  t.after(async () => { if (current) await current.close(); });
  const port = current.server.address().port;
  const removed = await fetch(`http://127.0.0.1:${port}/api/library/${OTHER}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'X-Staff-Token': 'stage-staff',
    },
    body: JSON.stringify({ expectedGeneration: 2 }),
  });
  const removedBody = await removed.json();
  assert.equal(removed.status, 200, JSON.stringify(removedBody));
  assert.equal(removedBody.deleted, true);
  const liveAttempt = await fetch(`http://127.0.0.1:${port}/api/library/${LIVE}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'X-Staff-Token': 'stage-staff',
    },
    body: JSON.stringify({ expectedGeneration: 1 }),
  });
  assert.equal(liveAttempt.status, 409);
  const liveBody = await liveAttempt.json();
  assert.equal(liveBody.code, 'live-production');
  const missing = await fetch(`http://127.0.0.1:${port}/api/library/${OTHER}`, {
    method: 'DELETE',
    headers: { 'X-Staff-Token': 'stage-staff', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(missing.status, 404);
  await current.close();
  current = await boot();
  const listed = await fetch(`http://127.0.0.1:${current.server.address().port}/api/library`, {
    headers: { 'X-Staff-Token': 'stage-staff' },
  });
  const body = await listed.json();
  assert.equal(listed.status, 200, JSON.stringify(body));
  assert.deepEqual(body.scripts.map((entry) => entry.id), [LIVE]);
  assert.equal(body.liveId, LIVE);
  assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'productions', OTHER)), false);
  assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'productions', LIVE, 'metadata.json')), true);
  assertCheckoutSeedIntact(REPO);
});

test('seed initialization does not restore a deleted production', async (t) => {
  const parent = makeRoot(t);
  const paths = resolveInstallPaths({ home: path.join(parent, 'home'), env: {}, repoRoot: REPO });
  assert.equal(paths.ok, true, paths.error);
  const installed = ensureVersionedInstall(paths);
  assert.equal(installed.ok, true, installed.error);
  assert.equal(installed.seeded, true);
  fs.mkdirSync(paths.journalDir, { recursive: true });
  const service = createVersionedLibraryService({
    root: paths.dataRoot,
    libraryDir: paths.libraryDir,
    scriptFile: paths.scriptFile,
    journalDir: paths.journalDir,
    now: () => NOW,
  });
  assert.equal(service.ok, true, service.error);
  const welcomeDelete = await service.deleteProduction({ productionId: WELCOME_ID });
  assert.equal(welcomeDelete.code, 'live-production');
  const renamed = await service.renameProduction({
    productionId: WELCOME_ID,
    title: 'WELCOME RENAMED',
    expectedGeneration: 1,
  });
  assert.equal(renamed.ok, true, renamed.error);
  const welcomeFile = path.join(paths.libraryDir, 'productions', WELCOME_ID, 'metadata.json');
  const welcomeBefore = fs.readFileSync(welcomeFile);
  assert.equal(JSON.parse(welcomeBefore.toString('utf8')).title, 'WELCOME RENAMED');
  const created = await service.createProduction({
    productionId: OTHER,
    versionId: OTHER_VERSION,
    title: 'Hamlet',
    text: OTHER_TEXT,
    createdAt: CREATED,
  });
  assert.equal(created.ok, true, created.error);
  const removed = await service.deleteProduction({ productionId: OTHER, expectedGeneration: 1 });
  assert.equal(removed.ok, true, removed.error);
  await service.close();
  fs.rmSync(paths.runtimeConfigPath);
  const again = ensureVersionedInstall(paths);
  assert.equal(again.ok, true, again.error);
  assert.equal(again.seeded, false);
  assert.equal(fs.existsSync(path.join(paths.libraryDir, 'productions', OTHER)), false);
  assert.equal(fs.readFileSync(welcomeFile).equals(welcomeBefore), true);
  const reopened = createVersionedLibraryService({
    root: paths.dataRoot,
    libraryDir: paths.libraryDir,
    scriptFile: paths.scriptFile,
    journalDir: paths.journalDir,
    now: () => NOW,
  });
  t.after(() => reopened.close());
  const listed = await reopened.listProductions();
  assert.equal(listed.ok, true, listed.error);
  assert.deepEqual(listed.productions.map((entry) => entry.productionId), [WELCOME_ID]);
  assertCheckoutSeedIntact(REPO);
});

test('the delete route follows the library staff check', async (t) => {
  const fixture = await prepareLibrary(t);
  const app = express();
  app.use(express.json());
  registerVersionedHttpRoutes({
    app,
    service: fixture.service,
    staffToken: 'stage-staff',
    now: () => NOW,
    allowFaults: true,
  });
  const server = http.createServer(app);
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const denied = await fetch(`${base}/api/library/${OTHER}`, { method: 'DELETE' });
  assert.equal(denied.status, 401);
  assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'productions', OTHER, 'metadata.json')), true);
  const allowed = await fetch(`${base}/api/library/${OTHER}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'X-Staff-Token': 'stage-staff',
      'X-Test-Fail-At': 'before-delete',
    },
    body: JSON.stringify({ expectedGeneration: 2 }),
  });
  const failed = await allowed.json();
  assert.equal(allowed.status, 503, JSON.stringify(failed));
  assert.equal(failed.code, 'storage-failure');
  assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'productions', OTHER, 'versions', OTHER_VERSION, 'script.txt')), true);
  assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'productions', OTHER, 'versions', OTHER_NEXT, 'script.txt')), true);
});
