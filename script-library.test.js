const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('os');
const path = require('node:path');
const { WebSocket } = require('ws');

const { createPrompterServer } = require('./server');
const {
  createScriptLibrary,
  createPrivatePathGuard,
  hashText,
  writeAtomic,
} = require('./script-library');
const {
  liveSwitchConfirmContent,
  reviewedLiveRevision,
  setLiveOutcome,
  setLiveRequestState,
} = require('./script-library-model');

const HAMLET = '# Hamlet\n[HAMLET]\nTo be or not to be.\n';
const MACBETH = '# Macbeth\n[MACBETH]\nTomorrow and tomorrow.\n---\n# Dunsinane\n[MACDUFF]\nTurn, hell-hound.\n';

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

async function closeAll(created, sockets) {
  sockets.forEach((socket) => socket.terminate());
  await new Promise((resolve) => created.wss.close(() => resolve()));
  if (created.server.listening) {
    await new Promise((resolve) => created.server.close(() => resolve()));
  }
}

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function startServer(t, options = {}) {
  const dir = options.dir || tempDir('prompter-library-');
  const scriptFile = options.scriptFile || path.join(dir, 'script.txt');
  const previousFile = options.previousFile || path.join(dir, 'script.previous.txt');
  const libraryDir = options.libraryDir || path.join(dir, 'data', 'library');
  if (options.scriptText !== undefined && !fs.existsSync(scriptFile)) {
    fs.writeFileSync(scriptFile, options.scriptText);
  }
  const created = createPrompterServer({
    scriptFile,
    previousFile,
    libraryDir,
    staffToken: options.staffToken !== undefined ? options.staffToken : '',
    imageMaxBytes: options.imageMaxBytes,
  });
  const sockets = [];
  t.after(async () => {
    await closeAll(created, sockets);
    if (!options.keepDir) fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, scriptFile, previousFile, libraryDir, created, sockets };
}

function setLive(base, id, revision, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (options.token) headers['X-Staff-Token'] = options.token;
  return fetch(`${base}/api/library/${id}/live`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ expectedRevision: revision }),
  });
}

test('library entries keep their own ids when titles match', () => {
  const dir = tempDir('prompter-lib-unit-');
  const library = createScriptLibrary({ dir });
  library.open();
  const first = library.create({ title: 'Hamlet', text: HAMLET });
  const second = library.create({ title: 'Hamlet', text: MACBETH });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.id, second.id);
  assert.equal(library.read(first.id).text, HAMLET);
  assert.equal(library.read(second.id).text, MACBETH);
  assert.equal(library.list().scripts.length, 2);

  const formatted = '# Scene\n[A]\nHello  \n\n{looks up}\n';
  const kept = library.create({ title: 'Spacing', text: formatted });
  assert.equal(library.read(kept.id).text, formatted);
  assert.equal(library.read(kept.id).revision, hashText(formatted));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('import validation and revision conflicts do not damage a saved script', () => {
  const dir = tempDir('prompter-lib-conflict-');
  const library = createScriptLibrary({ dir });
  library.open();
  const created = library.create({ title: 'Hamlet', text: HAMLET });
  assert.equal(library.create({ title: '   ', text: HAMLET }).ok, false);
  assert.equal(library.create({ title: '???', text: HAMLET }).ok, false);
  assert.equal(library.create({ title: 'Empty', text: '   ' }).code, 'invalid-script');
  assert.equal(library.create({ title: 'Blank name', text: '# Scene\n[]\nHello\n' }).ok, false);
  assert.equal(library.read(created.id).text, HAMLET);

  const stale = library.update(created.id, {
    text: MACBETH,
    expectedRevision: 'not-the-current-revision',
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.code, 'conflict');
  assert.equal(library.read(created.id).text, HAMLET);

  const renamed = library.update(created.id, {
    title: 'Hamlet company copy',
    expectedRevision: created.revision,
  });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.revision, created.revision);
  assert.equal(library.read(created.id).text, HAMLET);

  const updated = library.update(created.id, {
    text: MACBETH,
    expectedRevision: created.revision,
  });
  assert.equal(updated.ok, true);
  assert.notEqual(updated.revision, created.revision);
  const conflict = library.update(created.id, {
    text: HAMLET,
    expectedRevision: created.revision,
  });
  assert.equal(conflict.status, 409);
  assert.equal(library.read(created.id).text, MACBETH);
  assert.equal(library.read('../script.txt').code, 'invalid-id');
  assert.equal(library.read('..%2F..%2Fscript.txt').code, 'invalid-id');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a library survives a restart and a corrupt index', () => {
  const dir = tempDir('prompter-lib-restart-');
  const first = createScriptLibrary({ dir });
  first.open();
  const created = first.create({ title: 'Hamlet', text: HAMLET });
  first.setLiveId(created.id);

  const restarted = createScriptLibrary({ dir });
  restarted.open();
  assert.equal(restarted.getLiveId(), created.id);
  assert.equal(restarted.read(created.id).text, HAMLET);
  assert.equal(restarted.read(created.id).title, 'Hamlet');

  fs.writeFileSync(path.join(dir, 'index.json'), '{ this is not json');
  const repaired = createScriptLibrary({ dir });
  repaired.open();
  const recovered = repaired.read(created.id);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.text, HAMLET);
  assert.equal(repaired.list().scripts.length, 1);
  const quarantined = fs.readdirSync(dir).filter((name) => name.startsWith('index.corrupt-'));
  assert.equal(quarantined.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('adopting the current script is idempotent and does not replace other scripts', () => {
  const dir = tempDir('prompter-lib-adopt-');
  const library = createScriptLibrary({ dir });
  library.open();
  const other = library.create({ title: 'Macbeth', text: MACBETH });
  const first = library.adoptLiveText(HAMLET);
  const second = library.adoptLiveText(HAMLET);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.id, second.id);
  assert.equal(library.list().scripts.length, 2);
  assert.equal(library.read(other.id).text, MACBETH);
  assert.equal(library.getLiveId(), first.id);

  const changed = library.adoptLiveText(MACBETH);
  assert.equal(changed.created, false);
  assert.equal(changed.id, other.id);
  assert.equal(library.getLiveId(), other.id);
  assert.equal(library.list().scripts.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('atomic writes replace a script file completely', () => {
  const dir = tempDir('prompter-lib-atomic-');
  const filePath = path.join(dir, 'script.txt');
  writeAtomic(filePath, 'short');
  writeAtomic(filePath, `${HAMLET}and a last line\n`);
  assert.equal(fs.readFileSync(filePath, 'utf8'), `${HAMLET}and a last line\n`);
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the private path guard rejects library urls and path traversal', () => {
  const root = tempDir('prompter-lib-guard-');
  const libraryDir = path.join(root, 'data', 'library');
  fs.mkdirSync(libraryDir, { recursive: true });
  const journalDir = path.join(root, 'data', 'live-journal');
  const guard = createPrivatePathGuard(libraryDir, root, [journalDir]);
  function request(urlPath) {
    let status = 0;
    const res = {
      status(code) { status = code; return this; },
      type() { return this; },
      send(body) { this.body = body; },
    };
    let next = false;
    guard({ path: urlPath }, res, () => { next = true; });
    return { status, next, body: res.body };
  }
  assert.equal(request('/data/library/index.json').status, 404);
  assert.equal(request('/data/library/scripts/secret.txt').next, false);
  assert.equal(request('/data/live-journal/committed/live.txt').status, 404);
  assert.equal(request('/data/live-journal/pending/live.txt').next, false);
  assert.equal(request('/client.html').next, true);
  assert.equal(request('/script.txt').next, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('set-live confirmation names both scripts and waits for success', () => {
  const content = liveSwitchConfirmContent('Hamlet', 'Macbeth');
  assert.match(content.message, /Controller, Actor, and Audience/);
  assert.match(content.notes.join('\n'), /Current live script: Hamlet/);
  assert.match(content.notes.join('\n'), /New live script: Macbeth/);
  assert.match(content.notes.join('\n'), /returned to Live/);
  assert.match(content.notes.join('\n'), /beginning/);
  assert.equal(setLiveRequestState(true).allowDismiss, false);
  const refused = setLiveOutcome(false, { ok: false, error: 'The live script was not changed.' });
  assert.equal(refused.closeConfirm, false);
  assert.equal(refused.review, false);
  const conflict = setLiveOutcome(false, {
    ok: false,
    code: 'conflict',
    error: 'This saved script changed after you reviewed it. It was not set live. Review the latest version, then set it live again.',
  });
  assert.equal(conflict.closeConfirm, false);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.review, true);
  assert.match(conflict.message, /was not set live/);
  const entry = { id: 'red', revision: 'revision-1' };
  assert.equal(reviewedLiveRevision(entry, null), 'revision-1');
  assert.equal(reviewedLiveRevision(entry, { id: 'other', revision: 'revision-9' }), 'revision-1');
  assert.equal(reviewedLiveRevision(entry, { id: 'red', revision: 'revision-2' }), 'revision-2');
  const success = setLiveOutcome(true, { ok: true, resetPosition: true });
  assert.equal(success.closeConfirm, true);
  assert.match(success.message, /beginning/);
});

test('saving a library script does not change the live script or connected clients', async (t) => {
  const fixture = startServer(t, { scriptText: HAMLET });
  const port = await listen(fixture.created.server);
  const base = `http://127.0.0.1:${port}`;
  const audience = openSocket(`ws://127.0.0.1:${port}`);
  const actor = openSocket(`ws://127.0.0.1:${port}`);
  fixture.sockets.push(audience.socket, actor.socket);
  await waitFor(() => audience.messages.some((message) => message.type === 'state'));
  const before = audience.messages.length;

  const created = await fetch(`${base}/api/library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Macbeth', text: MACBETH }),
  });
  const createdBody = await created.json();
  assert.equal(created.status, 201);
  const revised = `${MACBETH}[WITCH]\nWhen shall we three meet again?\n`;
  const saved = await fetch(`${base}/api/library/${createdBody.script.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: revised,
      expectedRevision: createdBody.script.revision,
    }),
  });
  const savedBody = await saved.json();
  assert.equal(saved.status, 200);
  assert.equal(savedBody.script.revision !== createdBody.script.revision, true);
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), HAMLET);
  const live = await fetch(`${base}/script`);
  assert.equal(await live.text(), HAMLET);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    audience.messages.slice(before).some((message) => message.type === 'script' && message.revision === savedBody.script.revision),
    false,
  );
  assert.equal(
    actor.messages.slice(before).some((message) => message.type === 'state'),
    false,
  );
});

test('setting a different production live resets the cue and reaches every client', async (t) => {
  const fixture = startServer(t, { scriptText: MACBETH });
  const port = await listen(fixture.created.server);
  const base = `http://127.0.0.1:${port}`;
  const controller = openSocket(`ws://127.0.0.1:${port}`);
  const actor = openSocket(`ws://127.0.0.1:${port}`);
  fixture.sockets.push(controller.socket, actor.socket);
  await waitFor(() => controller.messages.some((message) => message.type === 'state'));
  controller.socket.send(JSON.stringify({ type: 'goto', slideIndex: 1, lineIndex: 0 }));
  await waitFor(() => controller.messages.some((message) => (
    message.type === 'state' && message.state.slideIndex === 1
  )));

  const created = await fetch(`${base}/api/library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Hamlet', text: HAMLET }),
  });
  const createdBody = await created.json();
  const before = Math.max(controller.messages.length, actor.messages.length);
  const switched = await setLive(base, createdBody.script.id, createdBody.script.revision);
  const body = await switched.json();
  assert.equal(switched.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.resetPosition, true);
  assert.match(body.previousTitle, /Macbeth/);
  await waitFor(() => (
    controller.messages.slice(before).some((message) => message.type === 'script' && message.liveScriptId === body.liveId)
    && actor.messages.slice(before).some((message) => message.type === 'script' && message.revision === body.revision)
    && controller.messages.slice(before).some((message) => (
      message.type === 'state' && message.state.slideIndex === 0 && message.state.lineIndex === 0
    ))
    && actor.messages.slice(before).some((message) => (
      message.type === 'state' && message.state.slideIndex === 0 && message.state.lineIndex === 0
    ))
  ));
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), HAMLET);
  const macbeth = fixture.created.library.read(
    fixture.created.library.list().scripts.find((entry) => entry.title === 'Macbeth').id,
  );
  assert.equal(macbeth.text, MACBETH);

  const again = await setLive(base, body.liveId, createdBody.script.revision);
  const againBody = await again.json();
  assert.equal(againBody.unchanged, true);
  assert.equal(againBody.resetPosition, false);

  controller.socket.terminate();
  const reconnected = openSocket(`ws://127.0.0.1:${port}`);
  fixture.sockets.push(reconnected.socket);
  await waitFor(() => reconnected.messages.some((message) => (
    message.type === 'script' && message.liveScriptId === body.liveId && message.revision === body.revision
  )));
  const state = reconnected.messages.find((message) => message.type === 'state');
  assert.equal(state.state.slideIndex, 0);
  assert.equal(state.state.lineIndex, 0);
});

test('the selected live script is still the live script after a server restart', async (t) => {
  const dir = tempDir('prompter-lib-reboot-');
  const scriptFile = path.join(dir, 'script.txt');
  const previousFile = path.join(dir, 'script.previous.txt');
  const libraryDir = path.join(dir, 'data', 'library');
  fs.writeFileSync(scriptFile, MACBETH);
  const first = createPrompterServer({ scriptFile, previousFile, libraryDir });
  const sockets = [];
  t.after(async () => {
    await closeAll(first, sockets);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await listen(first.server);
  const created = await fetch(`http://127.0.0.1:${port}/api/library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Hamlet', text: HAMLET }),
  });
  const createdBody = await created.json();
  const switched = await setLive(
    `http://127.0.0.1:${port}`,
    createdBody.script.id,
    createdBody.script.revision,
  );
  assert.equal((await switched.json()).ok, true);
  await closeAll(first, sockets);

  const second = createPrompterServer({ scriptFile, previousFile, libraryDir });
  const secondSockets = [];
  t.after(async () => {
    await closeAll(second, secondSockets);
  });
  const secondPort = await listen(second.server);
  const listed = await fetch(`http://127.0.0.1:${secondPort}/api/library`);
  const listBody = await listed.json();
  assert.equal(listBody.liveId, createdBody.script.id);
  const live = await fetch(`http://127.0.0.1:${secondPort}/script`);
  assert.equal(await live.text(), HAMLET);
  const client = openSocket(`ws://127.0.0.1:${secondPort}`);
  secondSockets.push(client.socket);
  await waitFor(() => client.messages.some((message) => (
    message.type === 'script'
    && message.liveScriptId === createdBody.script.id
    && message.slides[0].title === 'Hamlet'
  )));
});

test('ordinary publishing still preserves position and does not replace an unrelated library script', async (t) => {
  const fixture = startServer(t, { scriptText: MACBETH });
  const port = await listen(fixture.created.server);
  const base = `http://127.0.0.1:${port}`;
  const client = openSocket(`ws://127.0.0.1:${port}`);
  fixture.sockets.push(client.socket);
  await waitFor(() => client.messages.some((message) => message.type === 'script'));
  const liveId = client.messages.find((message) => message.type === 'script').liveScriptId;
  const liveRevision = client.messages.find((message) => message.type === 'script').revision;
  client.socket.send(JSON.stringify({ type: 'goto', slideIndex: 1, lineIndex: 0 }));
  await waitFor(() => client.messages.some((message) => (
    message.type === 'state' && message.state.slideIndex === 1
  )));

  const other = await fetch(`${base}/api/library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Hamlet', text: HAMLET }),
  });
  const otherBody = await other.json();
  const edited = '# Macbeth\n[MACBETH]\nTomorrow.\n---\n# Dunsinane\n[MACDUFF]\nTurn.\n';
  const published = await fetch(`${base}/script`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'X-Library-Id': liveId,
      'X-Library-Revision': liveRevision,
    },
    body: edited,
  });
  const publishedBody = await published.json();
  assert.equal(publishedBody.ok, true);
  assert.equal(publishedBody.libraryUpdated, true);
  assert.equal(publishedBody.unchanged, false);
  assert.equal(fixture.created.library.read(liveId).text, edited);
  assert.equal(fixture.created.library.read(otherBody.script.id).text, HAMLET);

  await waitFor(() => {
    const scriptIndex = client.messages.findIndex((message) => (
      message.type === 'script' && message.revision === publishedBody.revision
    ));
    if (scriptIndex === -1) return false;
    return client.messages.slice(scriptIndex).some((message) => (
      message.type === 'state' && message.state.slideIndex === 1 && message.state.lineIndex === 0
    ));
  });

  const beforeReplace = client.messages.length;
  const replaced = await fetch(`${base}/script`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '# Macbeth\n[MACBETH]\nA different upload.\n---\n# Dunsinane\n[MACDUFF]\nStill here.\n',
  });
  const replacedBody = await replaced.json();
  assert.equal(replacedBody.ok, true);
  assert.equal(replacedBody.libraryUpdated, false);
  assert.equal(fixture.created.library.read(liveId).text, edited);
  assert.equal(fixture.created.library.read(otherBody.script.id).text, HAMLET);
  assert.equal(fs.readFileSync(fixture.previousFile, 'utf8'), edited);
  await waitFor(() => client.messages.slice(beforeReplace).some((message) => (
    message.type === 'state' && message.state.slideIndex === 1
  )));
});

test('an edit to the same live production keeps the current cue', async (t) => {
  const fixture = startServer(t, { scriptText: MACBETH });
  const port = await listen(fixture.created.server);
  const base = `http://127.0.0.1:${port}`;
  const client = openSocket(`ws://127.0.0.1:${port}`);
  fixture.sockets.push(client.socket);
  await waitFor(() => client.messages.some((message) => message.type === 'script' && message.liveScriptId));
  const liveId = client.messages.find((message) => message.type === 'script').liveScriptId;
  client.socket.send(JSON.stringify({ type: 'goto', slideIndex: 1, lineIndex: 0 }));
  await waitFor(() => client.messages.some((message) => (
    message.type === 'state' && message.state.slideIndex === 1
  )));
  const current = fixture.created.library.read(liveId);
  const edited = MACBETH.replace('Turn, hell-hound.', 'Turn.');
  const saved = await fetch(`${base}/api/library/${liveId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: edited, expectedRevision: current.revision }),
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), MACBETH);
  const before = client.messages.length;
  const switched = await setLive(base, liveId, savedBody.script.revision);
  const body = await switched.json();
  assert.equal(body.resetPosition, false);
  await waitFor(() => client.messages.slice(before).some((message) => (
    message.type === 'state' && message.state.slideIndex === 1 && message.state.lineIndex === 0
  )));
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), edited);
});

test('library files are not served statically and ids cannot traverse directories', async (t) => {
  const libraryDir = path.join(__dirname, 'data', `library-exposure-${process.pid}-${Date.now()}`);
  const dir = tempDir('prompter-lib-exposure-');
  const fixture = startServer(t, {
    dir,
    libraryDir,
    scriptText: HAMLET,
    keepDir: true,
  });
  t.after(() => {
    fs.rmSync(libraryDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await listen(fixture.created.server);
  const base = `http://127.0.0.1:${port}`;
  const secret = '# Secret\n[A]\nThis private production must not be served as a file.\n';
  const created = await fetch(`${base}/api/library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Secret', text: secret }),
  });
  const body = await created.json();
  const relative = path.relative(__dirname, libraryDir).split(path.sep).join('/');
  const indexUrl = `${base}/${relative}/index.json`;
  const scriptUrl = `${base}/${relative}/scripts/${body.script.id}.txt`;
  const indexResponse = await fetch(indexUrl);
  const scriptResponse = await fetch(scriptUrl);
  assert.equal(indexResponse.status, 404);
  assert.equal(scriptResponse.status, 404);
  assert.equal((await indexResponse.text()).includes('Secret'), false);
  assert.equal((await scriptResponse.text()).includes('private production'), false);

  const traversal = await fetch(
    `${base}/api/library/..%2F..%2F${relative}/scripts/${body.script.id}.txt`,
  );
  const traversalText = await traversal.text();
  assert.equal(traversal.status >= 400, true);
  assert.equal(traversalText.includes('private production'), false);
  const bogus = await fetch(`${base}/api/library/not-a-uuid`);
  assert.equal(bogus.status, 400);
  const missing = await fetch(`${base}/api/library/00000000-0000-4000-8000-000000000000`);
  const missingBody = await missing.json();
  assert.equal(missing.status, 404);
  assert.equal(JSON.stringify(missingBody).includes('private production'), false);

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Script Library/);
});

test('a staff token is required for library text when it is configured', async (t) => {
  const token = `staff-test-token-${process.pid}`;
  const fixture = startServer(t, { scriptText: HAMLET, staffToken: token });
  const port = await listen(fixture.created.server);
  const base = `http://127.0.0.1:${port}`;
  const access = await fetch(`${base}/api/library/access`);
  assert.equal((await access.json()).required, true);

  const hidden = await fetch(`${base}/api/library`);
  assert.equal(hidden.status, 401);
  assert.equal((await hidden.text()).includes(token), false);
  const wrong = await fetch(`${base}/api/library`, { headers: { 'X-Staff-Token': 'nope' } });
  assert.equal(wrong.status, 401);

  const allowed = await fetch(`${base}/api/library`, { headers: { 'X-Staff-Token': token } });
  assert.equal(allowed.status, 200);
  const created = await fetch(`${base}/api/library`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Staff-Token': token,
    },
    body: JSON.stringify({ title: 'Macbeth', text: MACBETH }),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  const deniedText = await fetch(`${base}/api/library/${createdBody.script.id}`);
  assert.equal(deniedText.status, 401);
  assert.equal((await deniedText.text()).includes('Tomorrow'), false);
});

test('the controller page offers the library without removing the current script tools', () => {
  const client = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8');
  assert.match(client, /id="btn-script-library"/);
  assert.match(client, /id="script-library"/);
  assert.match(client, /id="btn-edit-script"/);
  assert.match(client, /id="btn-upload-toggle"/);
  assert.match(client, /id="editor-save"/);
  assert.match(client, /id="editor-publish"/);
  assert.match(client, /id="editor-save-library"/);
  assert.match(client, /ScriptLibrary\.liveSwitchConfirmContent/);
  assert.match(client, /ScriptLibrary\.setLiveOutcome/);
  assert.match(client, /ScriptLibrary\.setLiveRequestState/);
  assert.match(client, /Manage Images/);
  assert.match(client, /Choose image/);
  assert.match(client, /ScriptEditor\.setSceneImage/);
  assert.match(client, /ScriptLibrary\.parseImageReference/);
  assert.match(client, /isActor && scriptChanged/);
  assert.match(client, /ActorModeModel\.followLive\(\)/);
});

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function jpegBytes(fill) {
  return Buffer.concat([
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]),
    Buffer.alloc(16, fill),
    Buffer.from([0xFF, 0xD9]),
  ]);
}

function webpBytes() {
  const payload = Buffer.from('VP8XXXXXXXXX');
  const buf = Buffer.alloc(12 + payload.length);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write('WEBP', 8);
  payload.copy(buf, 12);
  return buf;
}

async function uploadImage(base, scriptId, bytes, options = {}) {
  const headers = {
    'Content-Type': options.type || 'application/octet-stream',
    'X-Asset-Name': encodeURIComponent(options.name || 'card.png'),
  };
  if (options.token) headers['X-Staff-Token'] = options.token;
  return fetch(`${base}/api/library/${scriptId}/assets`, {
    method: 'POST',
    headers,
    body: bytes,
  });
}

test('image references keep legacy paths and name a production asset explicitly', () => {
  const { parseImageReference, imageReference, imageLabel, setLiveOutcome } = require('./script-library-model');
  assert.equal(parseImageReference('images/Title_Card.jpeg').kind, 'legacy');
  assert.equal(parseImageReference('images/../server.js').kind, 'unknown');
  assert.equal(parseImageReference('https://example.com/a.jpg').kind, 'unknown');
  const scriptId = '11111111-1111-4111-8111-111111111111';
  const assetId = '22222222-2222-4222-8222-222222222222';
  const reference = imageReference(scriptId, assetId);
  assert.equal(parseImageReference(reference).scriptId, scriptId);
  assert.equal(imageLabel(reference, [{ id: assetId, scriptId, name: 'Door.jpeg' }]), 'Door.jpeg');
  assert.equal(imageLabel('images/Title_Card.jpeg'), 'Title_Card.jpeg');
  const outcome = setLiveOutcome(true, { ok: true, resetPosition: true, missingImages: 1 });
  assert.match(outcome.message, /Some scene images could not be found/);
});

test('each production keeps its own copy when image file names match', async (t) => {
  const fixture = startServer(t, { scriptText: HAMLET });
  const port = await listen(fixture.created.server);
  const base = `http://127.0.0.1:${port}`;
  const first = await fetch(`${base}/api/library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Red show', text: HAMLET }),
  });
  const second = await fetch(`${base}/api/library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Blue show', text: MACBETH }),
  });
  const red = (await first.json()).script;
  const blue = (await second.json()).script;
  const redUpload = await uploadImage(base, red.id, jpegBytes(1), { name: 'backdrop.jpg', type: 'image/jpeg' });
  const blueUpload = await uploadImage(base, blue.id, jpegBytes(2), { name: 'backdrop.jpg', type: 'image/jpeg' });
  assert.equal(redUpload.status, 201);
  assert.equal(blueUpload.status, 201);
  const redAsset = (await redUpload.json()).asset;
  const blueAsset = (await blueUpload.json()).asset;
  assert.equal(redAsset.name, 'backdrop.jpg');
  assert.equal(blueAsset.name, 'backdrop.jpg');
  assert.notEqual(redAsset.id, blueAsset.id);
  const redBytes = Buffer.from(await (await fetch(`${base}/api/library/${red.id}/assets/${redAsset.id}`)).arrayBuffer());
  const blueBytes = Buffer.from(await (await fetch(`${base}/api/library/${blue.id}/assets/${blueAsset.id}`)).arrayBuffer());
  assert.deepEqual(redBytes, jpegBytes(1));
  assert.deepEqual(blueBytes, jpegBytes(2));
  const crossed = await fetch(`${base}/api/library/${red.id}/assets/${blueAsset.id}`);
  assert.equal(crossed.status, 404);

  const png = await uploadImage(base, red.id, TINY_PNG, { name: 'dot.png', type: 'image/png' });
  const webp = await uploadImage(base, red.id, webpBytes(), { name: 'dot.webp', type: 'image/webp' });
  assert.equal(png.status, 201);
  assert.equal(webp.status, 201);
  const listed = await fetch(`${base}/api/library/${red.id}/assets`);
  const names = (await listed.json()).assets.map((asset) => asset.name).sort();
  assert.deepEqual(names, ['backdrop.jpg', 'dot.png', 'dot.webp']);

  const text = await uploadImage(base, red.id, Buffer.from('this is not an image file'), { name: 'notes.svg', type: 'image/svg+xml' });
  assert.equal(text.status, 400);
  assert.match((await text.json()).error, /JPEG, PNG, or WebP/);
  const truncated = await uploadImage(base, red.id, Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.alloc(20, 1)]), { type: 'image/jpeg' });
  assert.equal(truncated.status, 400);
  assert.match((await truncated.json()).error, /incomplete/);
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), HAMLET);
});

test('oversized images are rejected and private files are not served from the library folder', async (t) => {
  const fixture = startServer(t, { scriptText: HAMLET, imageMaxBytes: 100 });
  const port = await listen(fixture.created.server);
  const base = `http://127.0.0.1:${port}`;
  const created = await fetch(`${base}/api/library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Hamlet', text: HAMLET }),
  });
  const script = (await created.json()).script;
  const tooBig = await uploadImage(
    base,
    script.id,
    Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.alloc(120, 3), Buffer.from([0xFF, 0xD9])]),
    { type: 'image/jpeg' },
  );
  assert.equal(tooBig.status, 413);
  assert.match((await tooBig.json()).error, /too large/);
  const saved = await uploadImage(base, script.id, TINY_PNG, { name: 'secret.png', type: 'image/png' });
  assert.equal(saved.status, 201);
  const asset = (await saved.json()).asset;
  const folder = path.relative(fixture.dir, fixture.libraryDir).split(path.sep).join('/');
  const direct = await fetch(`${base}/${folder}/assets/${script.id}/${asset.id}.png`);
  assert.equal(direct.status, 404);
  assert.equal((await direct.text()).includes('PNG'), false);
  const escaped = await fetch(`${base}/api/library/${script.id}/assets/..%2F..%2Findex.json`);
  assert.equal(escaped.status >= 400, true);
  const badId = await fetch(`${base}/api/library/${script.id}/assets/not-an-id`);
  assert.equal(badId.status, 404);
});

test('saving a library image reference does not change the live show', async (t) => {
  const fixture = startServer(t, { scriptText: HAMLET });
  const port = await listen(fixture.created.server);
  const base = `http://127.0.0.1:${port}`;
  const client = openSocket(`ws://127.0.0.1:${port}`);
  fixture.sockets.push(client.socket);
  await waitFor(() => client.messages.some((message) => message.type === 'script'));
  const before = client.messages.length;
  const created = await fetch(`${base}/api/library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Side show', text: MACBETH }),
  });
  const script = (await created.json()).script;
  const uploaded = await uploadImage(base, script.id, TINY_PNG, { name: 'door.png', type: 'image/png' });
  const asset = (await uploaded.json()).asset;
  const text = `# Side show\n@image: library:${script.id}/${asset.id}\n[MACBETH]\nTomorrow.\n`;
  const saved = await fetch(`${base}/api/library/${script.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, expectedRevision: script.revision }),
  });
  assert.equal(saved.status, 200);
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), HAMLET);
  assert.equal(client.messages.length, before);
  const hidden = await fetch(`${base}/api/live/assets/${script.id}/${asset.id}`);
  assert.equal(hidden.status, 404);
  const preview = await fetch(`${base}/api/library/${script.id}/assets/${asset.id}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type').includes('image/png'), true);
});

test('setting a production live shows only that production images and restore brings the previous ones back', async (t) => {
  const fixture = startServer(t, { scriptText: HAMLET });
  const port = await listen(fixture.created.server);
  const base = `http://127.0.0.1:${port}`;
  const actor = openSocket(`ws://127.0.0.1:${port}`);
  const audience = openSocket(`ws://127.0.0.1:${port}`);
  fixture.sockets.push(actor.socket, audience.socket);
  await waitFor(() => actor.messages.some((message) => message.type === 'script'));
  await waitFor(() => audience.messages.some((message) => message.type === 'script'));

  async function makeShow(title, text, bytes) {
    const created = await fetch(`${base}/api/library`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, text }),
    });
    const script = (await created.json()).script;
    const uploaded = await uploadImage(base, script.id, bytes, { name: 'backdrop.jpg', type: 'image/jpeg' });
    const asset = (await uploaded.json()).asset;
    const withImage = `# ${title}\n@image: library:${script.id}/${asset.id}\n[A]\nLine\n`;
    const saved = await fetch(`${base}/api/library/${script.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: withImage, expectedRevision: script.revision }),
    });
    assert.equal(saved.status, 200);
    return { id: script.id, assetId: asset.id, revision: (await saved.json()).script.revision, text: withImage };
  }

  const red = await makeShow('Red show', HAMLET, jpegBytes(4));
  const blue = await makeShow('Blue show', MACBETH, jpegBytes(5));
  const redLive = await setLive(base, red.id, red.revision);
  assert.equal((await redLive.json()).ok, true);
  const edited = `# Red show\n@image: library:${red.id}/${red.assetId}\n[A]\nChanged in the library only\n`;
  const libraryEdit = await fetch(`${base}/api/library/${red.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: edited, expectedRevision: red.revision }),
  });
  assert.equal(libraryEdit.status, 200);
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8').includes('Changed in the library only'), false);

  const blueLive = await setLive(base, blue.id, blue.revision);
  const blueBody = await blueLive.json();
  assert.equal(blueBody.resetPosition, true);
  await waitFor(() => audience.messages.some((message) => (
    message.type === 'script'
    && message.liveScriptId === blue.id
    && message.slides[0].titleImage === `library:${blue.id}/${blue.assetId}`
  )));
  await waitFor(() => actor.messages.some((message) => (
    message.type === 'state' && message.state.slideIndex === 0 && message.state.showTitleImage === true
  )));
  const blueBytes = Buffer.from(await (await fetch(`${base}/api/live/assets/${blue.id}/${blue.assetId}`)).arrayBuffer());
  assert.deepEqual(blueBytes, jpegBytes(5));
  assert.equal((await fetch(`${base}/api/live/assets/${red.id}/${red.assetId}`)).status, 404);

  const legacy = `# Legacy\n@image: images/Title_Card.jpeg\n[A]\nOld path\n`;
  const legacyScript = await fetch(`${base}/api/library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Legacy', text: legacy }),
  });
  const legacyBody = await legacyScript.json();
  const legacyId = legacyBody.script.id;
  const legacyLive = await setLive(base, legacyId, legacyBody.script.revision);
  assert.equal((await legacyLive.json()).ok, true);
  await waitFor(() => audience.messages.some((message) => (
    message.type === 'script' && message.slides[0].titleImage === 'images/Title_Card.jpeg'
  )));

  const previous = await fetch(`${base}/script/previous`);
  assert.equal(await previous.text(), blue.text);
  const restored = await fetch(`${base}/script`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: blue.text,
  });
  const restoredBody = await restored.json();
  assert.equal(restoredBody.ok, true);
  assert.equal(restoredBody.liveScriptId, blue.id);
  const restoredBytes = Buffer.from(await (await fetch(`${base}/api/live/assets/${blue.id}/${blue.assetId}`)).arrayBuffer());
  assert.deepEqual(restoredBytes, jpegBytes(5));
  const inUse = await fetch(`${base}/api/library/${blue.id}/assets/${blue.assetId}`, { method: 'DELETE' });
  assert.equal(inUse.status, 409);
  assert.match((await inUse.json()).error, /still used/);
});

test('restoring the previous live script keeps both library productions', async (t) => {
  const client = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8');
  const marker = "headers['X-Restore-Previous'] = '1'";
  const markerAt = client.indexOf(marker);
  assert.notEqual(markerAt, -1);
  const branchStart = client.lastIndexOf("if (mode === 'restore')", markerAt);
  const restoreBranch = client.slice(branchStart, client.indexOf('else if', markerAt));
  assert.doesNotMatch(restoreBranch, /X-Library-Id/);

  const fixture = startServer(t, { scriptText: HAMLET });
  const port = await listen(fixture.created.server);
  const base = `http://127.0.0.1:${port}`;

  async function makeShow(title, bytes) {
    const created = await fetch(`${base}/api/library`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, text: `# ${title}\n[A]\n${title} line\n` }),
    });
    const script = (await created.json()).script;
    const uploaded = await uploadImage(base, script.id, bytes, { name: 'backdrop.jpg', type: 'image/jpeg' });
    assert.equal(uploaded.status, 201);
    const asset = (await uploaded.json()).asset;
    const text = `# ${title}\n@image: library:${script.id}/${asset.id}\n[A]\n${title} line\n`;
    const saved = await fetch(`${base}/api/library/${script.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, expectedRevision: script.revision }),
    });
    assert.equal(saved.status, 200);
    return { id: script.id, assetId: asset.id, revision: (await saved.json()).script.revision, text };
  }

  const blue = await makeShow('Blue', jpegBytes(1));
  const red = await makeShow('Red', jpegBytes(2));
  assert.equal((await (await setLive(base, blue.id, blue.revision)).json()).ok, true);
  assert.equal((await (await setLive(base, red.id, red.revision)).json()).ok, true);

  function stored(id) {
    return fixture.created.library.read(id);
  }
  assert.equal(stored(blue.id).text, blue.text);
  assert.equal(stored(red.id).text, red.text);
  const previous = await (await fetch(`${base}/script/previous`)).text();
  assert.equal(previous, blue.text);

  const first = await fetch(`${base}/script`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'X-Library-Id': red.id,
      'X-Library-Revision': red.revision,
      'X-Restore-Previous': '1',
    },
    body: previous,
  });
  const firstBody = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstBody.ok, true);
  assert.equal(firstBody.libraryUpdated, false);
  assert.equal(firstBody.libraryConflict, false);
  assert.equal(firstBody.liveScriptId, blue.id);
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), blue.text);
  assert.equal(fs.readFileSync(fixture.previousFile, 'utf8'), red.text);
  assert.equal(stored(blue.id).text, blue.text);
  assert.equal(stored(blue.id).revision, blue.revision);
  assert.equal(stored(red.id).text, red.text);
  assert.equal(stored(red.id).revision, red.revision);
  assert.deepEqual(
    Buffer.from(await (await fetch(`${base}/api/live/assets/${blue.id}/${blue.assetId}`)).arrayBuffer()),
    jpegBytes(1),
  );
  assert.equal((await fetch(`${base}/api/live/assets/${red.id}/${red.assetId}`)).status, 404);

  const second = await fetch(`${base}/script`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'X-Library-Id': blue.id,
      'X-Library-Revision': blue.revision,
      'X-Restore-Previous': '1',
    },
    body: red.text,
  });
  const secondBody = await second.json();
  assert.equal(second.status, 200);
  assert.equal(secondBody.libraryUpdated, false);
  assert.equal(secondBody.liveScriptId, red.id);
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), red.text);
  assert.equal(fs.readFileSync(fixture.previousFile, 'utf8'), blue.text);
  assert.equal(stored(blue.id).text, blue.text);
  assert.equal(stored(blue.id).revision, blue.revision);
  assert.equal(stored(red.id).text, red.text);
  assert.equal(stored(red.id).revision, red.revision);
  assert.deepEqual(
    Buffer.from(await (await fetch(`${base}/api/live/assets/${red.id}/${red.assetId}`)).arrayBuffer()),
    jpegBytes(2),
  );
  assert.equal((await fetch(`${base}/api/live/assets/${blue.id}/${blue.assetId}`)).status, 404);

  const beforeMalformed = fs.readFileSync(fixture.scriptFile, 'utf8');
  const malformed = await fetch(`${base}/script`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'X-Library-Id': red.id,
      'X-Library-Revision': red.revision,
      'X-Restore-Previous': '1',
    },
    body: '# Other\n[A]\nThis must not replace either production.\n',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).ok, false);
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), beforeMalformed);
  assert.equal(fs.readFileSync(fixture.previousFile, 'utf8'), blue.text);
  assert.equal(stored(blue.id).text, blue.text);
  assert.equal(stored(red.id).text, red.text);
  assert.equal(fixture.created.library.getLiveId(), red.id);

  const bare = await fetch(`${base}/script`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'X-Library-Id': red.id,
      'X-Library-Revision': red.revision,
    },
    body: blue.text,
  });
  const bareBody = await bare.json();
  assert.equal(bare.status, 200);
  assert.equal(bareBody.libraryUpdated, false);
  assert.equal(bareBody.liveScriptId, blue.id);
  assert.equal(stored(blue.id).text, blue.text);
  assert.equal(stored(red.id).text, red.text);
  assert.equal(stored(red.id).revision, red.revision);
});

test('set as live rejects a stale revision and keeps the current show', async (t) => {
  const client = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8');
  assert.match(client, /expectedRevision: editorLibraryRevision/);
  assert.match(client, /expectedRevision: libraryPendingRevision/);
  assert.match(client, /Save to the library before setting this script live/);
  assert.match(client, /Review latest/);
  assert.match(client, /Load latest version/);
  assert.match(client, /reviewedLiveRevision\(entry, libraryReviewed\)/);

  const fixture = startServer(t, { scriptText: MACBETH });
  const port = await listen(fixture.created.server);
  const base = `http://127.0.0.1:${port}`;
  const firstController = openSocket(`ws://127.0.0.1:${port}`);
  const secondController = openSocket(`ws://127.0.0.1:${port}`);
  fixture.sockets.push(firstController.socket, secondController.socket);
  await waitFor(() => firstController.messages.some((message) => message.type === 'script' && message.liveScriptId));
  await waitFor(() => secondController.messages.some((message) => message.type === 'state'));
  const macbethId = firstController.messages.find((message) => message.type === 'script').liveScriptId;
  const macbethRevision = fixture.created.library.read(macbethId).revision;
  firstController.socket.send(JSON.stringify({ type: 'goto', slideIndex: 1, lineIndex: 0 }));
  await waitFor(() => firstController.messages.some((message) => (
    message.type === 'state' && message.state.slideIndex === 1
  )));

  const created = await fetch(`${base}/api/library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Red', text: '# Red\n[A]\nFirst line\n' }),
  });
  const createdScript = (await created.json()).script;
  const uploaded = await uploadImage(base, createdScript.id, jpegBytes(7), { name: 'door.jpg', type: 'image/jpeg' });
  assert.equal(uploaded.status, 201);
  const asset = (await uploaded.json()).asset;
  const reviewed = `# Red\n@image: library:${createdScript.id}/${asset.id}\n[A]\nReviewed line\n`;
  const saved = await fetch(`${base}/api/library/${createdScript.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: reviewed, expectedRevision: createdScript.revision }),
  });
  const reviewedRevision = (await saved.json()).script.revision;
  assert.equal(saved.status, 200);

  const matching = await setLive(base, createdScript.id, reviewedRevision);
  const matchingBody = await matching.json();
  assert.equal(matching.status, 200);
  assert.equal(matchingBody.ok, true);
  assert.equal(matchingBody.resetPosition, true);
  assert.equal(matchingBody.liveId, createdScript.id);
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), reviewed);
  assert.deepEqual(
    Buffer.from(await (await fetch(`${base}/api/live/assets/${createdScript.id}/${asset.id}`)).arrayBuffer()),
    jpegBytes(7),
  );
  await waitFor(() => {
    const latest = firstController.messages.filter((message) => message.type === 'state').at(-1);
    return latest && latest.state.slideIndex === 0 && latest.state.lineIndex === 0;
  });

  const back = await setLive(base, macbethId, macbethRevision);
  assert.equal((await back.json()).ok, true);
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), MACBETH);
  firstController.socket.send(JSON.stringify({ type: 'goto', slideIndex: 1, lineIndex: 0 }));
  await waitFor(() => {
    const latest = firstController.messages.filter((message) => message.type === 'state').at(-1);
    return latest && latest.state.slideIndex === 1;
  });
  const quietAt = firstController.messages.length;
  const secondQuietAt = secondController.messages.length;

  const newer = `# Red\n@image: library:${createdScript.id}/${asset.id}\n[A]\nA newer line that has not been reviewed\n`;
  const updated = await fetch(`${base}/api/library/${createdScript.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: newer, expectedRevision: reviewedRevision }),
  });
  const newerRevision = (await updated.json()).script.revision;
  assert.notEqual(newerRevision, reviewedRevision);
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), MACBETH);

  const stale = await setLive(base, createdScript.id, reviewedRevision);
  const staleBody = await stale.json();
  assert.equal(stale.status, 409);
  assert.equal(staleBody.ok, false);
  assert.equal(staleBody.code, 'conflict');
  assert.match(staleBody.error, /was not set live/);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(firstController.messages.length, quietAt);
  assert.equal(secondController.messages.length, secondQuietAt);
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), MACBETH);
  assert.equal(fixture.created.library.getLiveId(), macbethId);
  assert.equal(fixture.created.library.read(createdScript.id).text, newer);
  assert.equal(fixture.created.library.read(macbethId).text, MACBETH);
  const latestState = firstController.messages.filter((message) => message.type === 'state').at(-1);
  assert.equal(latestState.state.slideIndex, 1);
  assert.equal(latestState.state.lineIndex, 0);

  const current = await setLive(base, createdScript.id, newerRevision);
  const currentBody = await current.json();
  assert.equal(current.status, 200);
  assert.equal(currentBody.resetPosition, true);
  assert.equal(currentBody.liveId, createdScript.id);
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), newer);
  assert.deepEqual(
    Buffer.from(await (await fetch(`${base}/api/live/assets/${createdScript.id}/${asset.id}`)).arrayBuffer()),
    jpegBytes(7),
  );

  const renamed = await fetch(`${base}/api/library/${createdScript.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Red company copy', expectedRevision: newerRevision }),
  });
  const renamedBody = await renamed.json();
  assert.equal(renamed.status, 200);
  assert.equal(renamedBody.script.revision, newerRevision);
  const afterRename = await setLive(base, createdScript.id, newerRevision);
  const afterRenameBody = await afterRename.json();
  assert.equal(afterRename.status, 200);
  assert.equal(afterRenameBody.resetPosition, false);
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), newer);
  assert.equal(fixture.created.library.read(createdScript.id).title, 'Red company copy');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const afterRenameState = firstController.messages.filter((message) => message.type === 'state').at(-1);
  assert.equal(afterRenameState.state.slideIndex, 0);
  assert.equal(afterRenameState.state.lineIndex, 0);

  const missing = await fetch(`${base}/api/library/${createdScript.id}/live`, { method: 'POST' });
  const missingBody = await missing.json();
  assert.equal(missing.status, 400);
  assert.equal(missingBody.code, 'revision-required');
  assert.match(missingBody.error, /was not set live/);
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), newer);
  assert.equal(fixture.created.library.getLiveId(), createdScript.id);
  assert.equal(fixture.created.library.read(createdScript.id).revision, newerRevision);
});

test('uploaded images remain after a restart and require the staff code to change', async (t) => {
  const dir = tempDir('prompter-lib-images-');
  const scriptFile = path.join(dir, 'script.txt');
  const previousFile = path.join(dir, 'script.previous.txt');
  const libraryDir = path.join(dir, 'data', 'library');
  fs.writeFileSync(scriptFile, HAMLET);
  const token = 'staff-code';
  const first = createPrompterServer({ scriptFile, previousFile, libraryDir, staffToken: token });
  t.after(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await listen(first.server);
  const base = `http://127.0.0.1:${port}`;
  const created = await fetch(`${base}/api/library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Staff-Token': token },
    body: JSON.stringify({ title: 'Hamlet', text: HAMLET }),
  });
  const script = (await created.json()).script;
  const denied = await uploadImage(base, script.id, TINY_PNG, { name: 'door.png', type: 'image/png' });
  assert.equal(denied.status, 401);
  const uploaded = await uploadImage(base, script.id, TINY_PNG, { name: 'door.png', type: 'image/png', token });
  assert.equal(uploaded.status, 201);
  const asset = (await uploaded.json()).asset;
  const withImage = `# Hamlet\n@image: library:${script.id}/${asset.id}\n[HAMLET]\nTo be.\n`;
  const saved = await fetch(`${base}/api/library/${script.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Staff-Token': token },
    body: JSON.stringify({ text: withImage, expectedRevision: script.revision }),
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  const live = await setLive(base, script.id, savedBody.script.revision, { token });
  assert.equal((await live.json()).missingImages, 0);
  await closeAll(first, []);

  const second = createPrompterServer({ scriptFile, previousFile, libraryDir, staffToken: token });
  const secondPort = await listen(second.server);
  t.after(async () => {
    await closeAll(second, []);
  });
  const again = await fetch(`http://127.0.0.1:${secondPort}/api/live/assets/${script.id}/${asset.id}`);
  assert.equal(again.status, 200);
  assert.deepEqual(Buffer.from(await again.arrayBuffer()), TINY_PNG);
  const listed = await fetch(`http://127.0.0.1:${secondPort}/api/library/${script.id}/assets`);
  assert.equal(listed.status, 401);
  const allowed = await fetch(`http://127.0.0.1:${secondPort}/api/library/${script.id}/assets`, {
    headers: { 'X-Staff-Token': token },
  });
  assert.equal((await allowed.json()).assets[0].name, 'door.png');
  assert.equal(fs.existsSync(path.join(libraryDir, 'assets', script.id, `${asset.id}.png`)), true);
});
