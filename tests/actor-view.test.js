const test = require('node:test');
const assert = require('node:assert/strict');

const { createActorView } = require('../public/actor-view');
const NavigationModel = require('../navigation-model');
const ActorModeModel = require('../actor-mode-model');

const slides = [
  {
    title: 'Opening',
    lines: [{ text: 'Hello', speaker: '' }, { text: 'There', speaker: '' }],
    titleImage: null,
  },
];

function statusElements() {
  return {
    actorModeStatus: { textContent: '', dataset: {} },
    actorLivePosition: { textContent: '' },
    actorLiveRelative: { textContent: '' },
    btnReturnLive: { disabled: false },
  };
}

function harness(options) {
  const state = {
    slides,
    live: { slideIndex: 0, lineIndex: 0, showTitleImage: false },
  };
  const renders = [];
  const actor = createActorView({
    liveShow: {
      getSlides: () => state.slides,
      getLiveState: () => state.live,
    },
    stage: {
      render(position) { renders.push(position === undefined ? null : position); },
    },
    navigation: NavigationModel,
    actorMode: ActorModeModel,
    matchMedia: () => ({ matches: Boolean(options && options.reducedMotion) }),
    document: { body: { appendChild() {} } },
  });
  actor.init({
    stageElement: options && options.stageElement,
    getConnection: () => (options && options.connection) || ({
      status: 'connected',
      waitingForLiveState: false,
    }),
    elements: statusElements(),
    bindControls: false,
  });
  return { actor, state, renders };
}

test('starts following the shared live cue', () => {
  const { actor, state } = harness();
  assert.equal(actor.followsLive(), true);
  assert.equal(actor.isReturning(), false);
  assert.equal(actor.effectivePosition(), state.live);
  assert.deepEqual(actor.positionForStateMessage(), { render: true, position: null });
});

test('next and previous stay on this actor and do not move the live cue', () => {
  const { actor, state, renders } = harness();
  const live = state.live;
  actor.navigate('next');
  assert.equal(state.live, live);
  assert.equal(live.lineIndex, 0);
  assert.equal(actor.followsLive(), false);
  assert.equal(actor.effectivePosition().lineIndex, 1);
  assert.deepEqual(actor.positionForStateMessage(), { render: false, position: null });
  assert.equal(renders.length, 1);
  actor.navigate('prev');
  assert.equal(actor.effectivePosition().lineIndex, 0);
  assert.equal(live.lineIndex, 0);
  assert.equal(actor.send, undefined);
});

test('reduced motion returns to the newest live cue', () => {
  const { actor, state } = harness({ reducedMotion: true });
  actor.navigate('next');
  state.live = { slideIndex: 0, lineIndex: 0, showTitleImage: true };
  actor.returnToLive();
  assert.equal(actor.followsLive(), true);
  assert.equal(actor.effectivePosition(), state.live);
  assert.equal(actor.effectivePosition().showTitleImage, true);
});

test('a script revision returns the actor to Follow Live without clearing the cue', () => {
  const { actor, state } = harness();
  actor.navigate('next');
  actor.onScriptChanged();
  assert.equal(actor.followsLive(), true);
  assert.equal(actor.isReturning(), false);
  assert.equal(actor.effectivePosition(), state.live);
  assert.equal(state.live.lineIndex, 0);
});

test('separate actors do not share a browsing position', () => {
  const first = harness();
  const second = harness();
  first.actor.navigate('next');
  assert.equal(first.actor.effectivePosition().lineIndex, 1);
  assert.equal(second.actor.followsLive(), true);
  assert.equal(second.actor.effectivePosition(), second.state.live);
});

test('a socket close cancels Return to Live and reports browsing', () => {
  let cancelled = 0;
  let removed = false;
  const animation = () => ({
    cancel() { cancelled += 1; },
    finished: new Promise(() => {}),
  });
  const snapshot = {
    style: {},
    animate: animation,
    remove() { removed = true; },
  };
  const stageElement = {
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 20, height: 20 }),
    cloneNode: () => snapshot,
    animate: animation,
  };
  const { actor } = harness({ reducedMotion: false, stageElement });
  actor.navigate('next');
  actor.returnToLive();
  assert.equal(actor.isReturning(), true);
  const update = actor.positionForStateMessage();
  assert.equal(update.render, true);
  assert.equal(update.position.lineIndex, 0);
  assert.equal(actor.onSocketClosed(), true);
  assert.equal(actor.isReturning(), false);
  assert.equal(cancelled, 2);
  assert.equal(removed, true);
  assert.equal(actor.followsLive(), false);
});
