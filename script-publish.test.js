const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('os');
const path = require('node:path');
const { WebSocket } = require('ws');

const { createPrompterServer } = require('./server');

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

test('publish is acknowledged to every client and keeps the previous script', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-publish-'));
  const scriptFile = path.join(dir, 'script.txt');
  const previousFile = path.join(dir, 'script.previous.txt');
  const original = '# One\nHello\n---\n# Two\nThere\n';
  const next = '# One\nHello there\n---\n# Two\nThere\n';
  fs.writeFileSync(scriptFile, original);
  const created = createPrompterServer({ scriptFile, previousFile });
  const sockets = [];
  t.after(async () => {
    await closeAll(created, sockets);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const port = await listen(created.server);
  const base = `http://127.0.0.1:${port}`;
  const first = openSocket(`ws://127.0.0.1:${port}`);
  const second = openSocket(`ws://127.0.0.1:${port}`);
  sockets.push(first.socket, second.socket);
  await Promise.all([
    waitFor(() => first.messages.some((message) => message.type === 'script')),
    waitFor(() => second.messages.some((message) => message.type === 'script')),
  ]);

  const empty = await fetch(`${base}/script`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '   ',
  });
  assert.equal(empty.status, 400);
  assert.equal(fs.existsSync(previousFile), false);
  assert.equal(fs.readFileSync(scriptFile, 'utf8'), original);

  const missingPrevious = await fetch(`${base}/script/previous`);
  assert.equal(missingPrevious.status, 404);

  const published = await fetch(`${base}/script`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: next,
  });
  const body = await published.json();
  assert.equal(published.status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.revision, 'string');
  assert.equal(body.unchanged, false);
  await waitFor(() => (
    first.messages.some((message) => message.type === 'script' && message.revision === body.revision)
    && second.messages.some((message) => message.type === 'script' && message.revision === body.revision)
  ));
  assert.equal(fs.readFileSync(scriptFile, 'utf8'), next);
  assert.equal(fs.readFileSync(previousFile, 'utf8'), original);

  const repeat = await fetch(`${base}/script`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: next,
  });
  const repeatBody = await repeat.json();
  assert.equal(repeatBody.ok, true);
  assert.equal(repeatBody.unchanged, true);
  assert.equal(repeatBody.revision, body.revision);
  assert.equal(fs.readFileSync(previousFile, 'utf8'), original);

  const previous = await fetch(`${base}/script/previous`);
  assert.equal(previous.status, 200);
  assert.equal(await previous.text(), original);

  const restored = await fetch(`${base}/script`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: original,
  });
  const restoredBody = await restored.json();
  assert.equal(restoredBody.ok, true);
  assert.equal(fs.readFileSync(scriptFile, 'utf8'), original);
  assert.equal(fs.readFileSync(previousFile, 'utf8'), next);
  await waitFor(() => (
    first.messages.some((message) => message.type === 'script' && message.revision === restoredBody.revision)
    && second.messages.some((message) => message.type === 'script' && message.revision === restoredBody.revision)
  ));
});

test('a published shorter script clamps the live cue instead of keeping a stale line', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-position-'));
  const scriptFile = path.join(dir, 'script.txt');
  const previousFile = path.join(dir, 'script.previous.txt');
  fs.writeFileSync(scriptFile, '# One\nL0\nL1\nL2\nL3\nL4\nL5\n---\n# Two\nT0\n');
  const created = createPrompterServer({ scriptFile, previousFile });
  const sockets = [];
  t.after(async () => {
    await closeAll(created, sockets);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const port = await listen(created.server);
  const client = openSocket(`ws://127.0.0.1:${port}`);
  sockets.push(client.socket);
  await waitFor(() => client.messages.some((message) => message.type === 'state'));
  client.socket.send(JSON.stringify({ type: 'goto', slideIndex: 1, lineIndex: 0 }));
  await waitFor(() => client.messages.some((message) => (
    message.type === 'state' && message.state.slideIndex === 1
  )));

  const before = client.messages.length;
  const response = await fetch(`http://127.0.0.1:${port}/script`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '# Only\nLine\n',
  });
  const body = await response.json();
  assert.equal(body.ok, true);
  await waitFor(() => client.messages.slice(before).some((message) => (
    message.type === 'state'
    && message.state.slideIndex === 0
    && message.state.lineIndex === 0
  )));
  const script = client.messages.slice(before).find((message) => message.type === 'script');
  assert.equal(script.revision, body.revision);
  assert.equal(script.slides.length, 1);
});
