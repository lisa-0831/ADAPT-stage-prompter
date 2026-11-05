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
const { liveSwitchConfirmContent, setLiveOutcome, setLiveRequestState } = require('./script-library-model');

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
  });
  const sockets = [];
  t.after(async () => {
    await closeAll(created, sockets);
    if (!options.keepDir) fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, scriptFile, previousFile, libraryDir, created, sockets };
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
  const guard = createPrivatePathGuard(libraryDir, root);
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
  assert.equal(setLiveOutcome(false, { ok: false, error: 'The live script was not changed.' }).closeConfirm, false);
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
  const switched = await fetch(`${base}/api/library/${createdBody.script.id}/live`, { method: 'POST' });
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

  const again = await fetch(`${base}/api/library/${body.liveId}/live`, { method: 'POST' });
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
  const switched = await fetch(`http://127.0.0.1:${port}/api/library/${createdBody.script.id}/live`, {
    method: 'POST',
  });
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
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), MACBETH);
  const before = client.messages.length;
  const switched = await fetch(`${base}/api/library/${liveId}/live`, { method: 'POST' });
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
  assert.match(client, /isActor && scriptChanged/);
  assert.match(client, /ActorModeModel\.followLive\(\)/);
});
