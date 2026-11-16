const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { WebSocket } = require('ws');

const { createPrompterServer } = require('../server');
const { registerLiveSocketHandlers } = require('../server/live-socket');

const root = path.join(__dirname, '..');
const SCRIPT = [
  '# Opening',
  '@image: images/card.jpg',
  '[ADA]',
  'FIRST',
  'SECOND',
  '',
  '---',
  '# Gap',
  '',
  '---',
  '# Tail',
  '[ADA]',
  'END',
  '',
].join('\n');

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
        reject(new Error('timed out waiting for a socket message'));
        return;
      }
      setTimeout(tick, 15);
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

function cue(message) {
  return {
    slideIndex: message.state.slideIndex,
    lineIndex: message.state.lineIndex,
    showLine: message.state.showLine,
    showTitleImage: message.state.showTitleImage,
  };
}

async function disposableServer(t, scriptText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-live-socket-'));
  const resolved = path.resolve(dir);
  assert.equal(resolved.startsWith(path.resolve(os.tmpdir())), true);
  assert.equal(resolved.startsWith(`${path.resolve(root)}${path.sep}`), false);
  const scriptFile = path.join(dir, 'script.txt');
  const previousFile = path.join(dir, 'script.previous.txt');
  fs.writeFileSync(scriptFile, scriptText);
  const created = createPrompterServer({
    scriptFile,
    previousFile,
    libraryDir: path.join(dir, 'data', 'library'),
    journalDir: path.join(dir, 'data', 'live-journal'),
  });
  const sockets = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.terminate());
    await new Promise((resolve) => created.wss.close(() => resolve()));
    if (created.server.listening) {
      await new Promise((resolve) => created.server.close(() => resolve()));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  return {
    dir,
    scriptFile,
    created,
    sockets,
    url: `ws://127.0.0.1:${created.server.address().port}`,
    base: `http://127.0.0.1:${created.server.address().port}`,
  };
}

test('a connection receives the current script and then the current cue', async (t) => {
  const fixture = await disposableServer(t, SCRIPT);
  const client = openSocket(fixture.url);
  fixture.sockets.push(client.socket);
  await waitFor(() => client.messages.some((message) => message.type === 'state'));
  assert.deepEqual(client.messages.map((message) => message.type), ['script', 'state']);
  assert.equal(client.messages[0].slides[0].title, 'Opening');
  assert.equal(typeof client.messages[0].revision, 'string');
  assert.equal(typeof client.messages[0].liveScriptId, 'string');
  assert.deepEqual(cue(client.messages[1]), {
    slideIndex: 0,
    lineIndex: 0,
    showLine: true,
    showTitleImage: true,
  });
});

test('navigation, scene jumps, and boundaries stay on the shared cue', async (t) => {
  const fixture = await disposableServer(t, SCRIPT);
  const controller = openSocket(fixture.url);
  const audience = openSocket(fixture.url);
  fixture.sockets.push(controller.socket, audience.socket);
  await waitFor(() => controller.messages.length === 2 && audience.messages.length === 2);

  async function send(message) {
    const before = controller.messages.length;
    controller.socket.send(JSON.stringify(message));
    await waitFor(() => controller.messages.length >= before + 1 && audience.messages.length >= before + 1);
    assert.equal(controller.messages.length, before + 1);
    assert.equal(audience.messages.length, before + 1);
    assert.deepEqual(cue(controller.messages.at(-1)), cue(audience.messages.at(-1)));
    return cue(controller.messages.at(-1));
  }

  assert.deepEqual(await send({ type: 'navigate', direction: 'prev' }), {
    slideIndex: 0,
    lineIndex: 0,
    showLine: true,
    showTitleImage: true,
  });
  assert.deepEqual(await send({ type: 'navigate', direction: 'next' }), {
    slideIndex: 0,
    lineIndex: 0,
    showLine: true,
    showTitleImage: false,
  });
  assert.deepEqual(await send({ type: 'navigate', direction: 'nextSlide' }), {
    slideIndex: 1,
    lineIndex: 0,
    showLine: true,
    showTitleImage: false,
  });
  assert.deepEqual(await send({ type: 'goto', slideIndex: 99, lineIndex: 99 }), {
    slideIndex: 2,
    lineIndex: 0,
    showLine: true,
    showTitleImage: false,
  });
  assert.deepEqual(await send({ type: 'goto', slideIndex: 0, lineIndex: 0 }), {
    slideIndex: 0,
    lineIndex: 0,
    showLine: true,
    showTitleImage: true,
  });
  assert.deepEqual(await send({ type: 'navigate', direction: 'sideways' }), {
    slideIndex: 0,
    lineIndex: 0,
    showLine: true,
    showTitleImage: true,
  });

  const beforeUnknown = controller.messages.length;
  controller.socket.send(JSON.stringify({ type: 'not-a-command' }));
  controller.socket.send('not-json');
  controller.socket.send(JSON.stringify({ type: 'navigate', direction: 'next' }));
  await waitFor(() => controller.messages.length >= beforeUnknown + 1);
  assert.equal(controller.messages.length, beforeUnknown + 1);
  assert.equal(audience.messages.length, beforeUnknown + 1);
  assert.equal(controller.messages.at(-1).state.showTitleImage, false);
});

test('a later connection and a reload see the latest server cue', async (t) => {
  const fixture = await disposableServer(t, SCRIPT);
  const first = openSocket(fixture.url);
  fixture.sockets.push(first.socket);
  await waitFor(() => first.messages.length === 2);
  first.socket.send(JSON.stringify({ type: 'navigate', direction: 'next' }));
  await waitFor(() => first.messages.length === 3);

  const second = openSocket(fixture.url);
  fixture.sockets.push(second.socket);
  await waitFor(() => second.messages.length === 2);
  assert.deepEqual(second.messages.map((message) => message.type), ['script', 'state']);
  assert.deepEqual(cue(second.messages[1]), cue(first.messages.at(-1)));
  assert.equal(second.messages[1].state.showTitleImage, false);

  fs.writeFileSync(fixture.scriptFile, '# Only\n[ADA]\nRELOADED\n');
  first.socket.send(JSON.stringify({ type: 'reloadScript' }));
  await waitFor(() => first.messages.length === 5 && second.messages.length === 4);
  assert.deepEqual(first.messages.map((message) => message.type), [
    'script', 'state', 'state', 'script', 'state',
  ]);
  assert.deepEqual(second.messages.map((message) => message.type), [
    'script', 'state', 'script', 'state',
  ]);
  const reloaded = first.messages.at(-2);
  assert.equal(reloaded.slides.length, 1);
  assert.equal(reloaded.slides[0].lines[0].text, 'RELOADED');
  assert.deepEqual(cue(first.messages.at(-1)), {
    slideIndex: 0,
    lineIndex: 0,
    showLine: true,
    showTitleImage: false,
  });
  assert.deepEqual(cue(second.messages.at(-1)), cue(first.messages.at(-1)));
});

test('publishing still sends script, state, then the existing extra script message', async (t) => {
  const fixture = await disposableServer(t, '# Opening\n[ADA]\nFIRST\n');
  const client = openSocket(fixture.url);
  fixture.sockets.push(client.socket);
  await waitFor(() => client.messages.length === 2);
  const response = await fetch(`${fixture.base}/script`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '# Opening\n[ADA]\nUPDATED LINE\n',
  });
  assert.equal(response.status, 200);
  await waitFor(() => client.messages.length === 5);
  assert.deepEqual(client.messages.map((message) => message.type), [
    'script', 'state', 'script', 'state', 'script',
  ]);
  assert.equal(client.messages[2].slides[0].lines[0].text, 'UPDATED LINE');
  assert.equal(client.messages[4].slides[0].lines[0].text, 'UPDATED LINE');
  assert.equal(client.messages[3].state.slideIndex, 0);
  assert.equal(client.messages[3].state.lineIndex, 0);
  assert.match(fs.readFileSync(fixture.scriptFile, 'utf8'), /UPDATED LINE/);
});

test('separate servers do not share a cue or a second socket listener', async (t) => {
  const first = await disposableServer(t, SCRIPT);
  const second = await disposableServer(t, SCRIPT);
  const firstClient = openSocket(first.url);
  const secondClient = openSocket(second.url);
  first.sockets.push(firstClient.socket);
  second.sockets.push(secondClient.socket);
  await waitFor(() => firstClient.messages.length === 2 && secondClient.messages.length === 2);
  firstClient.socket.send(JSON.stringify({ type: 'navigate', direction: 'next' }));
  await waitFor(() => firstClient.messages.length === 3);
  assert.equal(secondClient.messages.length, 2);
  assert.equal(secondClient.messages[1].state.showTitleImage, true);
  assert.equal(firstClient.messages.at(-1).state.showTitleImage, false);

  const wss = new EventEmitter();
  registerLiveSocketHandlers({
    wss,
    getSlides() { return []; },
    getState() { return { slideIndex: 0, lineIndex: 0, showLine: true, showTitleImage: false }; },
    updateCue() {},
    getScriptRevision() { return ''; },
    getLiveScriptId() { return null; },
    broadcast() {},
    loadScript() {},
  });
  registerLiveSocketHandlers({
    wss,
    getSlides() { return [{ title: 'Other' }]; },
    getState() { return { slideIndex: 3, lineIndex: 1, showLine: true, showTitleImage: false }; },
    updateCue() {},
    getScriptRevision() { return 'other'; },
    getLiveScriptId() { return 'other-id'; },
    broadcast() {},
    loadScript() {},
  });
  assert.equal(wss.listenerCount('connection'), 1);
});
