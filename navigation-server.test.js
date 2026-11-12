const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocket } = require('ws');

const { createPrompterServer } = require('./server');
const { movePosition, positionsEqual, cueDistance } = require('./navigation-model');
const { browse, effectivePosition, followLive } = require('./actor-mode-model');

const SCRIPT = [
  '# Opening',
  '@image: images/opening.jpg',
  '---',
  '# Hello',
  '[A]',
  'One line',
  '---',
  '# Card',
  '@image: images/card.jpg',
  '[A]',
  'First',
  'Second',
  '---',
  '# Picture A',
  '@image: images/a.jpg',
  '---',
  '# Picture B',
  '@image: images/b.jpg',
  '---',
  '# Blank',
  '---',
  '# Tail',
  '[B]',
  'End',
  '---',
  '# Closing',
  '@image: images/closing.jpg',
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

function cueOf(message) {
  return {
    slideIndex: message.state.slideIndex,
    lineIndex: message.state.lineIndex,
    showTitleImage: message.state.showTitleImage,
  };
}

function assertCueInRange(slides, cue) {
  assert.equal(cue.lineIndex >= 0, true);
  const lines = slides[cue.slideIndex].lines;
  if (lines.length === 0) assert.equal(cue.lineIndex, 0);
  else assert.equal(cue.lineIndex < lines.length, true);
  if (lines.length === 0 && slides[cue.slideIndex].titleImage) {
    assert.equal(cue.showTitleImage, true);
  }
}

test('server navigation matches actor movement on image-only scenes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-nav-'));
  const scriptFile = path.join(dir, 'script.txt');
  const previousFile = path.join(dir, 'script.previous.txt');
  fs.writeFileSync(scriptFile, SCRIPT);
  const created = createPrompterServer({ scriptFile, previousFile });
  const sockets = [];
  t.after(async () => {
    await closeAll(created, sockets);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const port = await listen(created.server);
  const url = `ws://127.0.0.1:${port}`;
  const controller = openSocket(url);
  const audience = openSocket(url);
  const actorA = openSocket(url);
  const actorB = openSocket(url);
  sockets.push(controller.socket, audience.socket, actorA.socket, actorB.socket);
  await Promise.all([controller, audience, actorA, actorB].map((client) => (
    waitFor(() => client.messages.some((message) => message.type === 'state'))
  )));

  const slides = controller.messages.find((message) => message.type === 'script').slides;
  let live = cueOf(controller.messages.find((message) => message.type === 'state'));
  assert.deepEqual(live, { slideIndex: 0, lineIndex: 0, showTitleImage: true });

  const actorBrowsing = browse(movePosition(slides, movePosition(slides, live, 'next'), 'next'));
  const otherActor = browse(movePosition(slides, live, 'prev'));
  const browsedBeforeLiveMoved = { ...actorBrowsing.localPosition };
  const otherBeforeLiveMoved = { ...otherActor.localPosition };

  async function navigate(direction) {
    const controllerBefore = controller.messages.filter((message) => message.type === 'state').length;
    const audienceBefore = audience.messages.filter((message) => message.type === 'state').length;
    controller.socket.send(JSON.stringify({ type: 'navigate', direction }));
    await waitFor(() => (
      controller.messages.filter((message) => message.type === 'state').length >= controllerBefore + 1
      && audience.messages.filter((message) => message.type === 'state').length >= audienceBefore + 1
    ));
    const expected = movePosition(slides, live, direction);
    const controllerCue = cueOf(controller.messages.filter((message) => message.type === 'state').at(-1));
    const audienceCue = cueOf(audience.messages.filter((message) => message.type === 'state').at(-1));
    assert.deepEqual(controllerCue, expected);
    assert.deepEqual(audienceCue, expected);
    assertCueInRange(slides, controllerCue);
    live = controllerCue;
  }

  await navigate('next');
  await waitFor(() => (
    cueOf(actorA.messages.filter((message) => message.type === 'state').at(-1)).slideIndex === 1
    && cueOf(actorB.messages.filter((message) => message.type === 'state').at(-1)).slideIndex === 1
  ));
  assert.deepEqual(live, { slideIndex: 1, lineIndex: 0, showTitleImage: false });
  assert.deepEqual(cueOf(actorA.messages.filter((message) => message.type === 'state').at(-1)), live);
  assert.deepEqual(cueOf(actorB.messages.filter((message) => message.type === 'state').at(-1)), live);
  assert.deepEqual(actorBrowsing.localPosition, browsedBeforeLiveMoved);
  assert.deepEqual(otherActor.localPosition, otherBeforeLiveMoved);
  assert.equal(positionsEqual(actorBrowsing.localPosition, otherActor.localPosition), false);
  assert.deepEqual(effectivePosition(followLive(), live), live);
  assert.notEqual(cueDistance(slides, actorBrowsing.localPosition, live), 0);

  await navigate('prev');
  assert.deepEqual(live, { slideIndex: 0, lineIndex: 0, showTitleImage: true });
  assert.deepEqual(actorBrowsing.localPosition, browsedBeforeLiveMoved);

  const directions = [];
  for (let step = 0; step < 30; step += 1) directions.push('next');
  for (let step = 0; step < 30; step += 1) directions.push('prev');
  directions.push('nextSlide', 'nextSlide', 'prevSlide', 'next', 'prev');
  for (const direction of directions) {
    await navigate(direction);
  }

  assert.deepEqual(actorBrowsing.localPosition, browsedBeforeLiveMoved);
  assert.deepEqual(effectivePosition(followLive(), live), live);
  assert.equal(positionsEqual(actorBrowsing.localPosition, live), false);
});

test('a one-line scene and a lone title image stay inside the script', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-nav-ends-'));
  const scriptFile = path.join(dir, 'script.txt');
  fs.writeFileSync(scriptFile, '# Only\n[A]\nHello\n');
  const created = createPrompterServer({
    scriptFile,
    previousFile: path.join(dir, 'script.previous.txt'),
  });
  const sockets = [];
  const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-nav-image-'));
  let imageServer = null;
  const imageSockets = [];
  t.after(async () => {
    await closeAll(created, sockets);
    if (imageServer) await closeAll(imageServer, imageSockets);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(imageDir, { recursive: true, force: true });
  });
  const port = await listen(created.server);
  const client = openSocket(`ws://127.0.0.1:${port}`);
  sockets.push(client.socket);
  await waitFor(() => client.messages.some((message) => message.type === 'state'));

  for (const direction of ['next', 'prev', 'next', 'prev']) {
    client.socket.send(JSON.stringify({ type: 'navigate', direction }));
  }
  await waitFor(() => client.messages.filter((message) => message.type === 'state').length >= 5);
  client.messages.filter((message) => message.type === 'state').forEach((message) => {
    assert.deepEqual(cueOf(message), { slideIndex: 0, lineIndex: 0, showTitleImage: false });
  });

  const imageScript = path.join(imageDir, 'script.txt');
  fs.writeFileSync(imageScript, '# Card\n@image: images/card.jpg\n');
  imageServer = createPrompterServer({
    scriptFile: imageScript,
    previousFile: path.join(imageDir, 'script.previous.txt'),
  });
  const imagePort = await listen(imageServer.server);
  const imageClient = openSocket(`ws://127.0.0.1:${imagePort}`);
  imageSockets.push(imageClient.socket);
  await waitFor(() => imageClient.messages.some((message) => message.type === 'state'));
  for (const direction of ['next', 'prev']) {
    imageClient.socket.send(JSON.stringify({ type: 'navigate', direction }));
  }
  await waitFor(() => imageClient.messages.filter((message) => message.type === 'state').length >= 3);
  imageClient.messages.filter((message) => message.type === 'state').forEach((message) => {
    assert.deepEqual(cueOf(message), { slideIndex: 0, lineIndex: 0, showTitleImage: true });
  });
});
