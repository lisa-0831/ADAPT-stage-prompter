const test = require('node:test');
const assert = require('node:assert/strict');
const { createLiveShow } = require('./public/live-show');
const { createConnection } = require('./public/connection');

function element() {
  const classes = new Set();
  return {
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      has(name) { return classes.has(name); },
    },
    style: { display: '' },
  };
}

function harness(options) {
  const sockets = [];
  const timers = [];
  let nextTimer = 1;
  const live = createLiveShow();
  const log = [];
  const connDot = element();
  const connecting = element();
  const settings = options || {};

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
    }

    send(payload) {
      this.sent.push(payload);
    }
  }
  FakeSocket.OPEN = 1;

  const connection = createConnection({
    liveShow: live,
    stage: {
      rebuildSlideSelect() { log.push('rebuild'); },
      render(position) {
        log.push(['render', position === undefined ? null : position, connection.getStatus()]);
      },
    },
    actor: {
      onScriptChanged() { log.push('onScriptChanged'); },
      onSocketClosed() {
        log.push('onSocketClosed');
        return Boolean(settings.browsing);
      },
      positionForStateMessage() {
        log.push('positionForState');
        return settings.positionUpdate || { render: false, position: null };
      },
      updateStatus() { log.push(['updateStatus', connection.getStatus()]); },
    },
    WebSocket: FakeSocket,
    location: settings.location || { protocol: 'http:', host: '127.0.0.1:3999' },
    setTimeout(fn, delay) {
      const id = nextTimer;
      nextTimer += 1;
      timers.push({ id, fn, delay, cleared: false });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.find((item) => item.id === id);
      if (timer) timer.cleared = true;
    },
  });
  connection.init({
    isActor: Boolean(settings.isActor),
    connDot,
    connecting,
    onScriptApplied() { log.push('onScriptApplied'); },
  });

  return { connection, sockets, timers, live, log, connDot, connecting };
}

function scriptMessage(revision, line) {
  return {
    type: 'script',
    revision,
    slides: [{ lines: [{ text: line }] }],
    liveScriptId: 'prod-1',
  };
}

test('a closed socket does not send, and an open socket sends the same JSON', () => {
  const { connection, sockets } = harness();
  connection.connect();
  connection.send({ type: 'navigate', direction: 'next' });
  assert.equal(sockets[0].sent.length, 0);

  sockets[0].readyState = 1;
  connection.send({ type: 'navigate', direction: 'prev' });
  connection.send({ type: 'goto', slideIndex: 2, lineIndex: 0 });
  assert.deepEqual(sockets[0].sent, [
    '{"type":"navigate","direction":"prev"}',
    '{"type":"goto","slideIndex":2,"lineIndex":0}',
  ]);

  sockets[0].readyState = 3;
  connection.send({ type: 'navigate', direction: 'next' });
  assert.equal(sockets[0].sent.length, 2);
});

test('connect chooses ws or wss from the page location', () => {
  const plain = harness();
  plain.connection.connect();
  assert.equal(plain.sockets[0].url, 'ws://127.0.0.1:3999');

  const secure = harness({ location: { protocol: 'https:', host: 'show.example' } });
  secure.connection.connect();
  assert.equal(secure.sockets[0].url, 'wss://show.example');
});

test('the first script and the following cue arrive in order without resetting an actor', () => {
  const { connection, sockets, live, log } = harness({ isActor: true });
  connection.connect();
  const cue = { slideIndex: 0, lineIndex: 0, showTitleImage: false };
  sockets[0].onmessage({ data: JSON.stringify(scriptMessage('rev-1', 'HELLO')) });
  sockets[0].onmessage({ data: JSON.stringify({ type: 'state', state: cue }) });

  assert.deepEqual(log, [
    'rebuild',
    ['render', null, { status: 'connecting', waitingForLiveState: true }],
    ['updateStatus', { status: 'connecting', waitingForLiveState: true }],
    'onScriptApplied',
    'positionForState',
    ['updateStatus', { status: 'connecting', waitingForLiveState: false }],
  ]);
  assert.equal(live.getRevision(), 'rev-1');
  assert.deepEqual(live.getLiveState(), cue);
  assert.equal(connection.getStatus().waitingForLiveState, false);
});

test('a later script revision returns only an actor to Follow Live and leaves the cue clear', () => {
  const actor = harness({ isActor: true });
  actor.connection.connect();
  actor.sockets[0].onmessage({ data: JSON.stringify(scriptMessage('rev-1', 'HELLO')) });
  actor.sockets[0].onmessage({ data: JSON.stringify({
    type: 'state',
    state: { slideIndex: 0, lineIndex: 0 },
  }) });
  actor.log.length = 0;

  actor.sockets[0].onmessage({ data: JSON.stringify(scriptMessage('rev-2', 'REVISED')) });
  assert.deepEqual(actor.log, [
    'onScriptChanged',
    'rebuild',
    ['updateStatus', { status: 'connecting', waitingForLiveState: true }],
    'onScriptApplied',
  ]);
  assert.equal(actor.live.getLiveState(), null);
  assert.equal(actor.live.getRevision(), 'rev-2');

  const controller = harness({ isActor: false });
  controller.connection.connect();
  controller.sockets[0].onmessage({ data: JSON.stringify(scriptMessage('rev-1', 'HELLO')) });
  controller.sockets[0].onmessage({ data: JSON.stringify({
    type: 'state',
    state: { slideIndex: 0, lineIndex: 0 },
  }) });
  controller.log.length = 0;
  controller.sockets[0].onmessage({ data: JSON.stringify(scriptMessage('rev-2', 'REVISED')) });
  assert.deepEqual(controller.log, [
    'rebuild',
    ['render', null, { status: 'connecting', waitingForLiveState: false }],
    ['updateStatus', { status: 'connecting', waitingForLiveState: false }],
    'onScriptApplied',
  ]);
  assert.deepEqual(controller.live.getLiveState(), { slideIndex: 0, lineIndex: 0 });
});

test('a live cue does not render over a browsing actor, and a return transition uses the live cue', () => {
  const browsing = harness({ isActor: true });
  browsing.connection.connect();
  browsing.sockets[0].onmessage({ data: JSON.stringify({
    type: 'state',
    state: { slideIndex: 1, lineIndex: 0 },
  }) });
  assert.deepEqual(browsing.log, [
    'positionForState',
    ['updateStatus', { status: 'connecting', waitingForLiveState: false }],
  ]);
  assert.equal(browsing.log.some((entry) => Array.isArray(entry) && entry[0] === 'render'), false);

  const returning = harness({
    isActor: true,
    positionUpdate: { render: true, position: { slideIndex: 1, lineIndex: 0 } },
  });
  returning.connection.connect();
  const liveCue = { slideIndex: 1, lineIndex: 0 };
  returning.sockets[0].onmessage({ data: JSON.stringify({ type: 'state', state: liveCue }) });
  assert.deepEqual(returning.log[1], [
    'render',
    liveCue,
    { status: 'connecting', waitingForLiveState: false },
  ]);
});

test('close schedules one reconnect and keeps a browsing actor on the local cue', () => {
  const { connection, sockets, timers, connDot, connecting, log } = harness({
    isActor: true,
    browsing: true,
  });
  connection.connect();
  sockets[0].onmessage({ data: JSON.stringify(scriptMessage('rev-1', 'HELLO')) });
  sockets[0].onmessage({ data: JSON.stringify({
    type: 'state',
    state: { slideIndex: 0, lineIndex: 0 },
  }) });
  sockets[0].readyState = 1;
  sockets[0].onopen();
  log.length = 0;

  sockets[0].onclose();
  assert.equal(log[0], 'onSocketClosed');
  assert.deepEqual(log[1], [
    'render',
    null,
    { status: 'connected', waitingForLiveState: false },
  ]);
  assert.deepEqual(connection.getStatus(), {
    status: 'reconnecting',
    waitingForLiveState: true,
  });
  assert.equal(connecting.style.display, 'none');
  assert.equal(connDot.classList.has('connected'), false);
  assert.deepEqual(timers.map((timer) => timer.delay), [1500]);

  timers[0].fn();
  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].url, 'ws://127.0.0.1:3999');
});

test('opening the socket cancels the pending reconnect and does not clear the waiting flag', () => {
  const { connection, sockets, timers, connDot, connecting } = harness();
  connection.connect();
  sockets[0].onclose();
  assert.equal(timers[0].cleared, false);

  sockets[0].readyState = 1;
  sockets[0].onopen();
  assert.equal(timers[0].cleared, true);
  assert.equal(connDot.classList.has('connected'), true);
  assert.equal(connecting.style.display, 'none');
  assert.deepEqual(connection.getStatus(), {
    status: 'connected',
    waitingForLiveState: true,
  });
});

test('an audience disconnect shows the connecting overlay', () => {
  const { connection, sockets, connecting } = harness({ isActor: false });
  connection.connect();
  sockets[0].onopen();
  sockets[0].onclose();
  assert.equal(connecting.style.display, 'flex');
  assert.equal(connection.getStatus().status, 'reconnecting');
});

test('separate connections do not share a socket or a waiting flag', () => {
  const first = harness({ isActor: true });
  const second = harness({ isActor: true });
  first.connection.connect();
  second.connection.connect();
  first.sockets[0].onmessage({ data: JSON.stringify({
    type: 'state',
    state: { slideIndex: 0, lineIndex: 0 },
  }) });
  assert.equal(first.connection.getStatus().waitingForLiveState, false);
  assert.equal(second.connection.getStatus().waitingForLiveState, true);
  assert.equal(second.live.getLiveState(), null);
  assert.notEqual(first.sockets[0], second.sockets[0]);
});
