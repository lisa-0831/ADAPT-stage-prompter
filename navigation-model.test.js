const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cueDistance,
  cueIndex,
  cueProgressPercent,
  cueStatusLabel,
  movePosition,
  normalizePosition,
  positionsEqual,
} = require('./navigation-model');

const slides = [
  { title: 'One', lines: [{ text: '1' }, { text: '2' }], titleImage: 'one.jpg' },
  { title: 'Empty', lines: [], titleImage: null },
  { title: 'Image only', lines: [], titleImage: 'three.jpg' },
  { title: 'Four', lines: [{ text: '4' }], titleImage: null },
];

test('moves between lines without mutating the starting position', () => {
  const start = { slideIndex: 0, lineIndex: 0, showTitleImage: false };
  const next = movePosition(slides, start, 'next');

  assert.deepEqual(next, { slideIndex: 0, lineIndex: 1, showTitleImage: false });
  assert.deepEqual(start, { slideIndex: 0, lineIndex: 0, showTitleImage: false });
  assert.deepEqual(movePosition(slides, next, 'prev'), start);
});

test('moves across scenes in both directions', () => {
  const endOfFirst = { slideIndex: 0, lineIndex: 1, showTitleImage: false };
  const emptyScene = movePosition(slides, endOfFirst, 'next');
  const imageScene = movePosition(slides, emptyScene, 'next');

  assert.deepEqual(emptyScene, {
    slideIndex: 1,
    lineIndex: 0,
    showTitleImage: false,
  });
  assert.deepEqual(imageScene, {
    slideIndex: 2,
    lineIndex: 0,
    showTitleImage: true,
  });
  assert.deepEqual(movePosition(slides, imageScene, 'prev'), emptyScene);
});

test('shows title images before lines and handles image-only scenes', () => {
  const firstImage = { slideIndex: 0, lineIndex: 0, showTitleImage: true };
  assert.deepEqual(movePosition(slides, firstImage, 'next'), {
    slideIndex: 0,
    lineIndex: 0,
    showTitleImage: false,
  });

  const imageOnly = { slideIndex: 2, lineIndex: 0, showTitleImage: true };
  assert.deepEqual(movePosition(slides, imageOnly, 'next'), {
    slideIndex: 3,
    lineIndex: 0,
    showTitleImage: false,
  });
});

test('does not move beyond the first or last script position', () => {
  const first = { slideIndex: 0, lineIndex: 0, showTitleImage: true };
  const last = { slideIndex: 3, lineIndex: 0, showTitleImage: false };

  assert.equal(positionsEqual(movePosition(slides, first, 'prev'), first), true);
  assert.equal(positionsEqual(movePosition(slides, last, 'next'), last), true);
});

test('normalizes invalid positions to script bounds', () => {
  assert.deepEqual(
    normalizePosition(slides, {
      slideIndex: 20,
      lineIndex: 20,
      showTitleImage: true,
    }),
    { slideIndex: 3, lineIndex: 0, showTitleImage: false },
  );
});

test('assigns cue indexes across lines, images, and empty scenes', () => {
  assert.equal(cueIndex(slides, {
    slideIndex: 0,
    lineIndex: 0,
    showTitleImage: true,
  }), 0);
  assert.equal(cueIndex(slides, {
    slideIndex: 0,
    lineIndex: 0,
    showTitleImage: false,
  }), 1);
  assert.equal(cueIndex(slides, {
    slideIndex: 1,
    lineIndex: 0,
    showTitleImage: false,
  }), 3);
  assert.equal(cueIndex(slides, {
    slideIndex: 2,
    lineIndex: 0,
    showTitleImage: true,
  }), 4);
  assert.equal(cueIndex(slides, {
    slideIndex: 3,
    lineIndex: 0,
    showTitleImage: false,
  }), 5);
});

test('an image-only scene is never an invisible cue', () => {
  assert.deepEqual(
    normalizePosition(slides, { slideIndex: 2, lineIndex: -1, showTitleImage: false }),
    { slideIndex: 2, lineIndex: 0, showTitleImage: true },
  );
});

test('image-only scenes move to a real cue in both directions', () => {
  const script = [
    { title: 'Opening', lines: [], titleImage: 'opening.jpg' },
    { title: 'Hello', lines: [{ text: 'One line' }], titleImage: null },
    { title: 'Card', lines: [{ text: 'First' }, { text: 'Second' }], titleImage: 'card.jpg' },
    { title: 'Picture A', lines: [], titleImage: 'a.jpg' },
    { title: 'Picture B', lines: [], titleImage: 'b.jpg' },
    { title: 'Blank', lines: [], titleImage: null },
    { title: 'Tail', lines: [{ text: 'End' }], titleImage: null },
    { title: 'Closing', lines: [], titleImage: 'closing.jpg' },
  ];
  const opening = { slideIndex: 0, lineIndex: 0, showTitleImage: true };
  const hello = movePosition(script, opening, 'next');
  assert.deepEqual(hello, { slideIndex: 1, lineIndex: 0, showTitleImage: false });
  assert.deepEqual(movePosition(script, hello, 'prev'), opening);

  const cardImage = movePosition(script, hello, 'nextSlide');
  assert.deepEqual(cardImage, { slideIndex: 2, lineIndex: 0, showTitleImage: true });
  const firstLine = movePosition(script, cardImage, 'next');
  assert.deepEqual(firstLine, { slideIndex: 2, lineIndex: 0, showTitleImage: false });
  assert.deepEqual(movePosition(script, firstLine, 'prev'), cardImage);

  const pictureA = movePosition(script, { slideIndex: 2, lineIndex: 1, showTitleImage: false }, 'next');
  const pictureB = movePosition(script, pictureA, 'next');
  assert.deepEqual(pictureA, { slideIndex: 3, lineIndex: 0, showTitleImage: true });
  assert.deepEqual(pictureB, { slideIndex: 4, lineIndex: 0, showTitleImage: true });
  assert.deepEqual(movePosition(script, pictureB, 'prev'), pictureA);

  const blank = movePosition(script, pictureB, 'next');
  assert.deepEqual(blank, { slideIndex: 5, lineIndex: 0, showTitleImage: false });
  const tail = movePosition(script, blank, 'next');
  const closing = movePosition(script, tail, 'next');
  assert.deepEqual(closing, { slideIndex: 7, lineIndex: 0, showTitleImage: true });
  assert.deepEqual(movePosition(script, closing, 'next'), closing);
  assert.deepEqual(movePosition(script, opening, 'prev'), opening);
  assert.deepEqual(movePosition(script, pictureA, 'prevSlide'), cardImage);

  let cursor = opening;
  for (let step = 0; step < 30; step += 1) {
    const forward = movePosition(script, cursor, 'next');
    assert.equal(forward.lineIndex >= 0, true);
    const lines = script[forward.slideIndex].lines;
    if (lines.length === 0) assert.equal(forward.lineIndex, 0);
    if (lines.length === 0 && script[forward.slideIndex].titleImage) {
      assert.equal(forward.showTitleImage, true);
    }
    if (!positionsEqual(forward, cursor)) {
      assert.deepEqual(movePosition(script, forward, 'prev'), cursor);
    }
    cursor = forward;
  }
});

test('title-image cues keep their own status and progress', () => {
  const script = [
    { title: 'Opening', lines: [], titleImage: 'opening.jpg' },
    { title: 'Hello', lines: [{ text: 'One line' }], titleImage: null },
    { title: 'Picture A', lines: [], titleImage: 'a.jpg' },
    { title: 'Picture B', lines: [], titleImage: 'b.jpg' },
    { title: 'Tail', lines: [{ text: 'End' }], titleImage: null },
  ];
  const opening = { slideIndex: 0, lineIndex: 0, showTitleImage: true };
  const hello = movePosition(script, opening, 'next');
  const pictureA = movePosition(script, hello, 'next');
  const pictureB = movePosition(script, pictureA, 'next');
  const back = movePosition(script, pictureB, 'prev');

  assert.equal(cueStatusLabel(script, opening), 'Slide 1/5 · Title image');
  assert.equal(cueProgressPercent(script, opening), 0);
  assert.equal(cueStatusLabel(script, hello), 'Slide 2/5 · Line 1/1');
  assert.equal(cueProgressPercent(script, hello), 25);
  assert.equal(cueStatusLabel(script, pictureA), 'Slide 3/5 · Title image');
  assert.equal(cueProgressPercent(script, pictureA), 50);
  assert.equal(cueStatusLabel(script, pictureB), 'Slide 4/5 · Title image');
  assert.equal(cueProgressPercent(script, pictureB), 75);
  assert.notEqual(cueProgressPercent(script, pictureA), cueProgressPercent(script, pictureB));
  assert.deepEqual(back, pictureA);
  assert.equal(cueStatusLabel(script, back), 'Slide 3/5 · Title image');
  assert.equal(cueStatusLabel(script, { slideIndex: 2, lineIndex: 0, showTitleImage: true }), 'Slide 3/5 · Title image');
  assert.doesNotMatch(cueStatusLabel(script, pictureA), /Line /);
});

test('calculates whether live is ahead, behind, or at the actor position', () => {
  const actor = { slideIndex: 0, lineIndex: 1, showTitleImage: false };
  const liveAhead = { slideIndex: 2, lineIndex: 0, showTitleImage: true };
  const liveBehind = { slideIndex: 0, lineIndex: 0, showTitleImage: true };

  assert.equal(cueDistance(slides, actor, liveAhead), 2);
  assert.equal(cueDistance(slides, actor, liveBehind), -2);
  assert.equal(cueDistance(slides, actor, actor), 0);
});
