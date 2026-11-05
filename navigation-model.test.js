const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
