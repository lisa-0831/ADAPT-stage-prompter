const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocket } = require('ws');

const { createPrompterServer } = require('./server');
const { createScriptLibrary } = require('./script-library');
const {
  LIVE_WRITE_STAGES,
  commitLiveFiles,
  journalLayout,
  readBackupMeta,
  recoverLiveFiles,
} = require('./live-script-store');

const BLUE = '# Blue\n[BLUE]\nBlue line\n';
const RED = '# Red\n[RED]\nRed line\n';
const GREEN = '# Green\n[GREEN]\nGreen line\n';
function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fingerprint(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (current) => {
    fs.readdirSync(current).forEach((name) => {
      const full = path.join(current, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out[path.relative(dir, full)] = hashFile(full);
    });
  };
  walk(dir);
  return out;
}

function publicTemps(dir, journalDir) {
  const found = [];
  const skip = path.resolve(journalDir);
  const walk = (current) => {
    if (path.resolve(current) === skip) return;
    fs.readdirSync(current).forEach((name) => {
      const full = path.join(current, name);
      if (name.includes('.tmp') || name.startsWith('.install-')) found.push(path.relative(dir, full));
      else if (fs.statSync(full).isDirectory()) walk(full);
    });
  };
  if (fs.existsSync(dir)) walk(dir);
  return found;
}

function stopAt(stage) {
  return (name) => {
    if (name !== stage) return;
    const error = new Error(`injected-stop:${stage}`);
    error.code = 'injected-stop';
    throw error;
  };
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-live-journal-'));
  const libraryDir = path.join(dir, 'data', 'library');
  const library = createScriptLibrary({ dir: libraryDir });
  library.open();
  const blue = library.create({ title: 'Blue', text: BLUE });
  const red = library.create({ title: 'Red', text: RED });
  const green = library.create({ title: 'Green', text: GREEN });
  const paths = {
    dir,
    libraryDir,
    library,
    blue,
    red,
    green,
    scriptFile: path.join(dir, 'script.txt'),
    previousFile: path.join(dir, 'script.previous.txt'),
    metaFile: path.join(dir, 'script.previous.txt.meta.json'),
    journalDir: path.join(dir, 'data', 'live-journal'),
  };
  paths.identityMatches = (liveId, text) => {
    const record = library.read(liveId);
    return Boolean(record.ok && record.text === text);
  };
  return paths;
}

function writeLegacyMeta(filePath, liveId) {
  fs.writeFileSync(filePath, `${JSON.stringify({ liveId })}\n`);
}

function savedText(library, id) {
  return library.read(id).text;
}

function earlyStage(stage) {
  return stage === 'before-live' || stage === 'temps-prepared';
}

LIVE_WRITE_STAGES.forEach((stage) => {
  test(`an interrupted live save at ${stage} recovers one coherent backup`, () => {
    const fx = makeFixture();
    fs.writeFileSync(fx.scriptFile, BLUE);
    fs.writeFileSync(fx.previousFile, GREEN);
    writeLegacyMeta(fx.metaFile, fx.green.id);
    const originalMeta = fs.readFileSync(fx.metaFile);
    const libraryBefore = fingerprint(fx.libraryDir);
    assert.throws(
      () => commitLiveFiles({
        ...fx,
        nextText: RED,
        nextPreviousText: BLUE,
        nextPreviousLiveId: fx.blue.id,
        onStage: stopAt(stage),
      }),
      (error) => error.code === 'injected-stop',
    );
    assert.deepEqual(publicTemps(fx.dir, fx.journalDir), [], stage);
    const layout = journalLayout(fx.journalDir);

    if (stage === 'before-live') {
      assert.equal(fs.existsSync(layout.pending), false, stage);
      assert.equal(fs.existsSync(layout.committed), false, stage);
    }
    if (stage === 'temps-prepared') {
      assert.equal(fs.readFileSync(path.join(layout.pending, 'live.txt'), 'utf8'), RED);
      assert.equal(fs.existsSync(layout.committed), false, stage);
      assert.equal(fs.readFileSync(fx.scriptFile, 'utf8'), BLUE, stage);
      assert.equal(fs.readFileSync(fx.previousFile, 'utf8'), GREEN, stage);
    }
    if (stage === 'backup-content') {
      fs.writeFileSync(path.join(fx.journalDir, '.install-script.txt'), 'temp');
      assert.equal(fs.readFileSync(fx.previousFile, 'utf8'), BLUE, stage);
      assert.equal(fs.readFileSync(fx.scriptFile, 'utf8'), BLUE, stage);
      assert.equal(fs.readFileSync(fx.metaFile, 'utf8'), originalMeta.toString(), stage);
      assert.equal(fs.existsSync(layout.committed), true, stage);
    }
    if (stage === 'backup-meta' || stage === 'before-activate') {
      assert.equal(fs.readFileSync(fx.scriptFile, 'utf8'), BLUE, stage);
      assert.equal(fs.readFileSync(fx.previousFile, 'utf8'), BLUE, stage);
      assert.equal(readBackupMeta(fx.metaFile, fx.previousFile).liveId, fx.blue.id, stage);
      assert.equal(fs.existsSync(layout.committed), true, stage);
    }
    if (stage === 'after-activate') {
      assert.equal(fs.readFileSync(fx.scriptFile, 'utf8'), RED, stage);
      assert.equal(fs.readFileSync(fx.previousFile, 'utf8'), BLUE, stage);
      assert.equal(readBackupMeta(fx.metaFile, fx.previousFile).liveId, fx.blue.id, stage);
      assert.equal(fs.existsSync(layout.committed), true, stage);
    }

    recoverLiveFiles(fx);
    if (earlyStage(stage)) {
      assert.equal(fs.readFileSync(fx.scriptFile, 'utf8'), BLUE, stage);
      assert.equal(fs.readFileSync(fx.previousFile, 'utf8'), GREEN, stage);
      assert.equal(fs.readFileSync(fx.metaFile, 'utf8'), originalMeta.toString(), stage);
      assert.equal(readBackupMeta(fx.metaFile, fx.previousFile).liveId, fx.green.id, stage);
    } else {
      assert.equal(fs.readFileSync(fx.scriptFile, 'utf8'), RED, stage);
      assert.equal(fs.readFileSync(fx.previousFile, 'utf8'), BLUE, stage);
      const meta = readBackupMeta(fx.metaFile, fx.previousFile);
      assert.equal(meta.liveId, fx.blue.id, stage);
      assert.equal(meta.mismatched, false, stage);
      assert.equal(savedText(fx.library, fx.green.id), GREEN, stage);
    }
    assert.equal(fs.existsSync(layout.pending), false, stage);
    assert.equal(fs.existsSync(layout.committed), false, stage);
    assert.equal(fs.existsSync(path.join(fx.journalDir, '.install-script.txt')), false, stage);
    assert.deepEqual(publicTemps(fx.dir, fx.journalDir), [], stage);
    assert.deepEqual(fingerprint(fx.libraryDir), libraryBefore, stage);
    assert.equal(savedText(fx.library, fx.blue.id), BLUE, stage);
    assert.equal(savedText(fx.library, fx.red.id), RED, stage);
    const settled = fs.readFileSync(fx.scriptFile);
    const settledPrevious = fs.readFileSync(fx.previousFile);
    const settledMeta = fs.readFileSync(fx.metaFile);
    recoverLiveFiles(fx);
    assert.equal(fs.readFileSync(fx.scriptFile).equals(settled), true, stage);
    assert.equal(fs.readFileSync(fx.previousFile).equals(settledPrevious), true, stage);
    assert.equal(fs.readFileSync(fx.metaFile).equals(settledMeta), true, stage);
    fs.rmSync(fx.dir, { recursive: true, force: true });
  });
});

LIVE_WRITE_STAGES.forEach((stage) => {
  test(`an interrupted restore at ${stage} recovers the previous production`, () => {
    const fx = makeFixture();
    fs.writeFileSync(fx.scriptFile, RED);
    fs.writeFileSync(fx.previousFile, BLUE);
    const metaText = `${JSON.stringify({
      liveId: fx.blue.id,
      textHash: crypto.createHash('sha256').update(BLUE).digest('hex'),
    })}\n`;
    fs.writeFileSync(fx.metaFile, metaText);
    const libraryBefore = fingerprint(fx.libraryDir);
    assert.throws(
      () => commitLiveFiles({
        ...fx,
        nextText: BLUE,
        nextPreviousText: RED,
        nextPreviousLiveId: fx.red.id,
        onStage: stopAt(stage),
      }),
      (error) => error.code === 'injected-stop',
    );
    assert.deepEqual(publicTemps(fx.dir, fx.journalDir), [], stage);
    recoverLiveFiles(fx);
    if (earlyStage(stage)) {
      assert.equal(fs.readFileSync(fx.scriptFile, 'utf8'), RED, stage);
      assert.equal(fs.readFileSync(fx.previousFile, 'utf8'), BLUE, stage);
      assert.equal(readBackupMeta(fx.metaFile, fx.previousFile).liveId, fx.blue.id, stage);
    } else {
      assert.equal(fs.readFileSync(fx.scriptFile, 'utf8'), BLUE, stage);
      assert.equal(fs.readFileSync(fx.previousFile, 'utf8'), RED, stage);
      const meta = readBackupMeta(fx.metaFile, fx.previousFile);
      assert.equal(meta.liveId, fx.red.id, stage);
      assert.equal(meta.mismatched, false, stage);
    }
    assert.deepEqual(fingerprint(fx.libraryDir), libraryBefore, stage);
    assert.equal(fs.existsSync(journalLayout(fx.journalDir).committed), false, stage);
    assert.equal(fs.existsSync(journalLayout(fx.journalDir).pending), false, stage);
    fs.rmSync(fx.dir, { recursive: true, force: true });
  });
});

function waitFor(predicate, timeout = 3000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) {
          resolve();
          return;
        }
      } catch (err) {
        reject(err);
        return;
      }
      if (Date.now() - start > timeout) {
        reject(new Error('timed out waiting for server event'));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function openSocket(url) {
  const socket = new WebSocket(url);
  const messages = [];
  socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
  socket.on('error', () => {});
  return { socket, messages };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function closeServer(created, sockets) {
  sockets.forEach((socket) => socket.terminate());
  await new Promise((resolve) => created.wss.close(() => resolve()));
  if (created.server.listening) {
    await new Promise((resolve) => created.server.close(() => resolve()));
  }
}

function setLive(base, id, revision) {
  return fetch(`${base}/api/library/${id}/live`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: revision }),
  });
}

async function uploadImage(base, scriptId, bytes) {
  return fetch(`${base}/api/library/${scriptId}/assets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'image/jpeg',
      'X-Asset-Name': encodeURIComponent('door.jpg'),
    },
    body: bytes,
  });
}

test('startup keeps a coherent legacy backup and drops a mismatched production id', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-live-legacy-'));
  const scriptFile = path.join(dir, 'script.txt');
  const previousFile = path.join(dir, 'script.previous.txt');
  const metaFile = `${previousFile}.meta.json`;
  const libraryDir = path.join(dir, 'data', 'library');
  const library = createScriptLibrary({ dir: libraryDir });
  library.open();
  const blue = library.create({ title: 'Blue', text: BLUE });
  const green = library.create({ title: 'Green', text: GREEN });
  fs.writeFileSync(scriptFile, BLUE);
  fs.writeFileSync(previousFile, GREEN);
  const legacyMeta = `${JSON.stringify({ liveId: green.id })}\n`;
  fs.writeFileSync(metaFile, legacyMeta);
  library.setLiveId(blue.id);

  const coherent = createPrompterServer({ scriptFile, previousFile, libraryDir });
  t.after(async () => {
    await closeServer(coherent, []);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await listen(coherent.server);
  assert.equal(fs.readFileSync(metaFile, 'utf8'), legacyMeta);
  assert.equal(fs.readFileSync(previousFile, 'utf8'), GREEN);
  assert.equal(library.read(green.id).text, GREEN);
  assert.equal(library.read(blue.id).text, BLUE);
  const base = `http://127.0.0.1:${port}`;
  const missing = await fetch(`${base}/script/previous`);
  assert.equal(missing.status, 200);
  assert.equal(await missing.text(), GREEN);
  await closeServer(coherent, []);

  fs.writeFileSync(scriptFile, BLUE);
  fs.writeFileSync(previousFile, BLUE);
  fs.writeFileSync(metaFile, legacyMeta);
  const torn = createPrompterServer({ scriptFile, previousFile, libraryDir });
  const tornPort = await listen(torn.server);
  const tornBase = `http://127.0.0.1:${tornPort}`;
  const repaired = readBackupMeta(metaFile, previousFile);
  assert.equal(repaired.liveId, null);
  assert.equal(library.read(green.id).text, GREEN);
  assert.equal(library.read(blue.id).text, BLUE);
  assert.equal(torn.library.getLiveId(), blue.id);
  const restored = await fetch(`${tornBase}/script`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-Restore-Previous': '1' },
    body: BLUE,
  });
  const restoredBody = await restored.json();
  assert.equal(restored.status, 200);
  assert.equal(restoredBody.liveScriptId, blue.id);
  assert.notEqual(restoredBody.liveScriptId, green.id);
  assert.equal(fs.readFileSync(scriptFile, 'utf8'), BLUE);
  assert.equal(library.read(green.id).text, GREEN);
  await closeServer(torn, []);

  fs.rmSync(previousFile, { force: true });
  fs.writeFileSync(metaFile, legacyMeta);
  fs.writeFileSync(scriptFile, BLUE);
  const orphan = createPrompterServer({ scriptFile, previousFile, libraryDir });
  await listen(orphan.server);
  assert.equal(fs.existsSync(metaFile), false);
  assert.equal(fs.readFileSync(scriptFile, 'utf8'), BLUE);
  assert.equal(library.read(blue.id).text, BLUE);
  await closeServer(orphan, []);

  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-live-empty-'));
  const freshScript = path.join(freshDir, 'script.txt');
  const freshPrevious = path.join(freshDir, 'script.previous.txt');
  fs.writeFileSync(freshScript, BLUE);
  const fresh = createPrompterServer({
    scriptFile: freshScript,
    previousFile: freshPrevious,
    libraryDir: path.join(freshDir, 'data', 'library'),
  });
  const freshPort = await listen(fresh.server);
  assert.equal(fs.existsSync(freshPrevious), false);
  assert.equal((await fetch(`http://127.0.0.1:${freshPort}/script/previous`)).status, 404);
  await closeServer(fresh, []);
  fs.rmSync(freshDir, { recursive: true, force: true });
});

test('startup finishes a save that crashed before the new script was activated', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-live-restart-'));
  const scriptFile = path.join(dir, 'script.txt');
  const previousFile = path.join(dir, 'script.previous.txt');
  const libraryDir = path.join(dir, 'data', 'library');
  fs.writeFileSync(scriptFile, BLUE);
  const sockets = [];
  let armed = false;
  const crashing = createPrompterServer({
    scriptFile,
    previousFile,
    libraryDir,
    onLiveWriteStage(name) {
      if (armed && name === 'backup-content') {
        const error = new Error('injected-stop');
        error.code = 'injected-stop';
        throw error;
      }
    },
  });
  t.after(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await listen(crashing.server);
  const base = `http://127.0.0.1:${port}`;
  const audience = openSocket(`ws://127.0.0.1:${port}`);
  sockets.push(audience.socket);
  await waitFor(() => audience.messages.some((message) => message.type === 'script' && message.liveScriptId));
  const listed = await (await fetch(`${base}/api/library`)).json();
  const blueId = listed.liveId;
  const created = await fetch(`${base}/api/library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Red', text: RED }),
  });
  const red = (await created.json()).script;
  const quietAt = audience.messages.length;
  armed = true;
  const published = await fetch(`${base}/script`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: RED,
  });
  assert.equal(published.status, 500);
  assert.equal(audience.messages.length, quietAt);
  assert.equal(fs.readFileSync(scriptFile, 'utf8'), BLUE);
  assert.equal(fs.readFileSync(previousFile, 'utf8'), BLUE);
  assert.equal(crashing.library.read(red.id).text, RED);
  assert.equal(crashing.library.read(blueId).text, BLUE);
  await closeServer(crashing, sockets);

  const restarted = createPrompterServer({ scriptFile, previousFile, libraryDir });
  const restartedSockets = [];
  const restartedPort = await listen(restarted.server);
  const restartedBase = `http://127.0.0.1:${restartedPort}`;
  const viewer = openSocket(`ws://127.0.0.1:${restartedPort}`);
  restartedSockets.push(viewer.socket);
  await waitFor(() => viewer.messages.some((message) => (
    message.type === 'script' && message.slides[0].title === 'Red'
  )));
  assert.equal(fs.readFileSync(scriptFile, 'utf8'), RED);
  assert.equal(fs.readFileSync(previousFile, 'utf8'), BLUE);
  assert.equal(readBackupMeta(`${previousFile}.meta.json`, previousFile).liveId, blueId);
  assert.equal(restarted.library.read(red.id).text, RED);
  assert.equal(restarted.library.read(blueId).text, BLUE);
  assert.equal((await (await fetch(`${restartedBase}/script`)).text()), RED);
  assert.equal((await (await fetch(`${restartedBase}/script/previous`)).text()), BLUE);
  await closeServer(restarted, restartedSockets);
});

test('a crashed restore restarts on the reviewed production and can switch back', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-live-restore-'));
  const scriptFile = path.join(dir, 'script.txt');
  const previousFile = path.join(dir, 'script.previous.txt');
  const libraryDir = path.join(dir, 'data', 'library');
  fs.writeFileSync(scriptFile, BLUE);
  const sockets = [];
  let armed = false;
  const first = createPrompterServer({
    scriptFile,
    previousFile,
    libraryDir,
    onLiveWriteStage(name) {
      if (armed && name === 'before-activate') {
        throw Object.assign(new Error('injected-stop'), { code: 'injected-stop' });
      }
    },
  });
  t.after(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await listen(first.server);
  const base = `http://127.0.0.1:${port}`;
  const client = openSocket(`ws://127.0.0.1:${port}`);
  sockets.push(client.socket);
  await waitFor(() => client.messages.some((message) => message.type === 'script' && message.liveScriptId));
  const blueId = client.messages.find((message) => message.type === 'script').liveScriptId;
  const created = await fetch(`${base}/api/library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Red', text: RED }),
  });
  const red = (await created.json()).script;
  const switched = await setLive(base, red.id, red.revision);
  assert.equal(switched.status, 200);
  assert.equal(fs.readFileSync(scriptFile, 'utf8'), RED);
  assert.equal(fs.readFileSync(previousFile, 'utf8'), BLUE);
  const quietAt = client.messages.length;
  armed = true;
  const crashed = await fetch(`${base}/script`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-Restore-Previous': '1' },
    body: BLUE,
  });
  assert.equal(crashed.status, 500);
  assert.equal(client.messages.length, quietAt);
  assert.equal(fs.readFileSync(scriptFile, 'utf8'), RED);
  assert.equal(first.library.read(red.id).text, RED);
  assert.equal(first.library.read(blueId).text, BLUE);
  await closeServer(first, sockets);

  const second = createPrompterServer({ scriptFile, previousFile, libraryDir });
  const secondPort = await listen(second.server);
  const secondBase = `http://127.0.0.1:${secondPort}`;
  assert.equal(fs.readFileSync(scriptFile, 'utf8'), BLUE);
  assert.equal(fs.readFileSync(previousFile, 'utf8'), RED);
  assert.equal(readBackupMeta(`${previousFile}.meta.json`, previousFile).liveId, red.id);
  assert.equal(second.library.getLiveId(), blueId);
  assert.equal(second.library.read(red.id).text, RED);
  assert.equal(second.library.read(blueId).text, BLUE);
  const back = await fetch(`${secondBase}/script`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-Restore-Previous': '1' },
    body: RED,
  });
  const backBody = await back.json();
  assert.equal(back.status, 200);
  assert.equal(backBody.liveScriptId, red.id);
  assert.equal(fs.readFileSync(scriptFile, 'utf8'), RED);
  assert.equal(fs.readFileSync(previousFile, 'utf8'), BLUE);
  assert.equal(second.library.read(red.id).text, RED);
  assert.equal(second.library.read(blueId).text, BLUE);
  await closeServer(second, []);
});

test('a crashed set-live recovers that production, its image, and still rejects a stale revision', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-live-set-'));
  const scriptFile = path.join(dir, 'script.txt');
  const previousFile = path.join(dir, 'script.previous.txt');
  const libraryDir = path.join(dir, 'data', 'library');
  fs.writeFileSync(scriptFile, BLUE);
  const sockets = [];
  let armed = false;
  const first = createPrompterServer({
    scriptFile,
    previousFile,
    libraryDir,
    onLiveWriteStage(name) {
      if (armed && name === 'backup-meta') {
        throw Object.assign(new Error('injected-stop'), { code: 'injected-stop' });
      }
    },
  });
  t.after(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await listen(first.server);
  const base = `http://127.0.0.1:${port}`;
  const audience = openSocket(`ws://127.0.0.1:${port}`);
  sockets.push(audience.socket);
  await waitFor(() => audience.messages.some((message) => message.type === 'script' && message.liveScriptId));
  const blueId = audience.messages.find((message) => message.type === 'script').liveScriptId;

  async function makeShow(title, text, fill) {
    const created = await fetch(`${base}/api/library`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, text }),
    });
    const script = (await created.json()).script;
    const uploaded = await uploadImage(base, script.id, Buffer.concat([
      Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]),
      Buffer.alloc(16, fill),
      Buffer.from([0xFF, 0xD9]),
    ]));
    assert.equal(uploaded.status, 201);
    const asset = (await uploaded.json()).asset;
    const withImage = `# ${title}\n@image: library:${script.id}/${asset.id}\n[${title.toUpperCase()}]\n${title} line\n`;
    const saved = await fetch(`${base}/api/library/${script.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: withImage, expectedRevision: script.revision }),
    });
    const savedBody = await saved.json();
    assert.equal(saved.status, 200);
    return { id: script.id, revision: savedBody.script.revision, text: withImage, assetId: asset.id, fill };
  }

  const red = await makeShow('Red', RED, 5);
  const green = await makeShow('Green', GREEN, 9);
  const redLive = await setLive(base, red.id, red.revision);
  assert.equal(redLive.status, 200);
  assert.equal(fs.readFileSync(scriptFile, 'utf8'), red.text);
  assert.equal(readBackupMeta(`${previousFile}.meta.json`, previousFile).liveId, blueId);
  const quietAt = audience.messages.length;
  armed = true;
  const crashed = await setLive(base, green.id, green.revision);
  assert.equal(crashed.status, 500);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(audience.messages.length, quietAt);
  assert.equal(fs.readFileSync(scriptFile, 'utf8'), red.text);
  assert.equal(first.library.getLiveId(), red.id);
  assert.equal(first.library.read(green.id).text, green.text);
  assert.equal(first.library.read(red.id).text, red.text);
  assert.equal(first.library.read(blueId).text, BLUE);
  await closeServer(first, sockets);

  const second = createPrompterServer({ scriptFile, previousFile, libraryDir });
  const secondPort = await listen(second.server);
  const secondBase = `http://127.0.0.1:${secondPort}`;
  assert.equal(fs.readFileSync(scriptFile, 'utf8'), green.text);
  assert.equal(fs.readFileSync(previousFile, 'utf8'), red.text);
  assert.equal(readBackupMeta(`${previousFile}.meta.json`, previousFile).liveId, red.id);
  assert.equal(second.library.getLiveId(), green.id);
  assert.equal(second.library.read(green.id).revision, green.revision);
  assert.equal(second.library.read(red.id).text, red.text);
  assert.equal(second.library.read(blueId).text, BLUE);
  const liveImage = Buffer.from(await (await fetch(`${secondBase}/api/live/assets/${green.id}/${green.assetId}`)).arrayBuffer());
  assert.equal(liveImage[liveImage.length - 3], 9);
  assert.equal((await fetch(`${secondBase}/api/live/assets/${red.id}/${red.assetId}`)).status, 404);
  const storedImage = Buffer.from(await (await fetch(`${secondBase}/api/library/${red.id}/assets/${red.assetId}`)).arrayBuffer());
  assert.equal(storedImage[storedImage.length - 3], 5);
  const stale = await setLive(secondBase, green.id, red.revision);
  const staleBody = await stale.json();
  assert.equal(stale.status, 409);
  assert.equal(staleBody.code, 'conflict');
  assert.equal(fs.readFileSync(scriptFile, 'utf8'), green.text);
  assert.equal(second.library.getLiveId(), green.id);
  assert.equal(fs.readFileSync(previousFile, 'utf8'), red.text);
  await closeServer(second, []);
});

test('publishing an edit keeps the backup production id after a restart', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-live-edit-'));
  const scriptFile = path.join(dir, 'script.txt');
  const previousFile = path.join(dir, 'script.previous.txt');
  const libraryDir = path.join(dir, 'data', 'library');
  fs.writeFileSync(scriptFile, BLUE);
  const first = createPrompterServer({ scriptFile, previousFile, libraryDir });
  t.after(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await listen(first.server);
  const base = `http://127.0.0.1:${port}`;
  const listed = await (await fetch(`${base}/api/library`)).json();
  const blue = listed.scripts.find((entry) => entry.id === listed.liveId);
  const edited = '# Blue\n[BLUE]\nA saved edit\n';
  const published = await fetch(`${base}/script`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'X-Library-Id': blue.id,
      'X-Library-Revision': blue.revision,
    },
    body: edited,
  });
  const publishedBody = await published.json();
  assert.equal(publishedBody.ok, true);
  assert.equal(publishedBody.libraryUpdated, true);
  assert.equal(fs.readFileSync(previousFile, 'utf8'), BLUE);
  assert.equal(readBackupMeta(`${previousFile}.meta.json`, previousFile).liveId, blue.id);
  await closeServer(first, []);

  const second = createPrompterServer({ scriptFile, previousFile, libraryDir });
  await listen(second.server);
  assert.equal(fs.readFileSync(scriptFile, 'utf8'), edited);
  assert.equal(fs.readFileSync(previousFile, 'utf8'), BLUE);
  assert.equal(readBackupMeta(`${previousFile}.meta.json`, previousFile).liveId, blue.id);
  assert.equal(second.library.read(blue.id).text, edited);
  assert.equal(second.library.getLiveId(), blue.id);
  await closeServer(second, []);
});

test('a stale revision does not start a live-script save', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-live-stale-'));
  const scriptFile = path.join(dir, 'script.txt');
  const previousFile = path.join(dir, 'script.previous.txt');
  const libraryDir = path.join(dir, 'data', 'library');
  const journalDir = path.join(dir, 'data', 'live-journal');
  fs.writeFileSync(scriptFile, BLUE);
  const createdServer = createPrompterServer({ scriptFile, previousFile, libraryDir });
  t.after(async () => {
    await closeServer(createdServer, []);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await listen(createdServer.server);
  const base = `http://127.0.0.1:${port}`;
  const created = await fetch(`${base}/api/library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Red', text: RED }),
  });
  const red = (await created.json()).script;
  const stale = await setLive(base, red.id, 'not-the-reviewed-revision');
  assert.equal(stale.status, 409);
  assert.equal(fs.readFileSync(scriptFile, 'utf8'), BLUE);
  assert.equal(fs.existsSync(previousFile), false);
  assert.equal(fs.existsSync(journalDir), false);
  assert.equal(createdServer.library.read(red.id).text, RED);
});
