const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MODES,
  browse,
  effectivePosition,
  followLive,
} = require('./actor-mode-model');

test('starts in FOLLOW_LIVE without a local position', () => {
  assert.deepEqual(followLive(), {
    mode: MODES.FOLLOW_LIVE,
    localPosition: null,
  });
});

test('FOLLOW_LIVE always resolves to the latest live position', () => {
  const readingState = followLive();
  const firstLive = { slideIndex: 0, lineIndex: 1 };
  const nextLive = { slideIndex: 2, lineIndex: 3 };

  assert.equal(effectivePosition(readingState, firstLive), firstLive);
  assert.equal(effectivePosition(readingState, nextLive), nextLive);
});

test('BROWSING resolves to its local position without mutating input', () => {
  const localPosition = { slideIndex: 1, lineIndex: 2, showTitleImage: false };
  const readingState = browse(localPosition);
  const livePosition = { slideIndex: 3, lineIndex: 4 };

  assert.equal(readingState.mode, MODES.BROWSING);
  assert.deepEqual(effectivePosition(readingState, livePosition), localPosition);
  assert.notEqual(readingState.localPosition, localPosition);
});

test('returning to FOLLOW_LIVE uses the newest live position', () => {
  const newestLive = { slideIndex: 4, lineIndex: 5 };
  const returnedState = followLive();

  assert.equal(returnedState.mode, MODES.FOLLOW_LIVE);
  assert.equal(effectivePosition(returnedState, newestLive), newestLive);
});

test('actor reading states remain independent', () => {
  const actorA = followLive();
  const actorB = browse({ slideIndex: 2, lineIndex: 0 });
  const livePosition = { slideIndex: 1, lineIndex: 3 };

  assert.equal(effectivePosition(actorA, livePosition), livePosition);
  assert.deepEqual(effectivePosition(actorB, livePosition), {
    slideIndex: 2,
    lineIndex: 0,
  });
});
