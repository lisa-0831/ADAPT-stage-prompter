const test = require('node:test');
const assert = require('node:assert/strict');

const { directionForKey } = require('./actor-input-model');

test('maps Actor previous navigation keys', () => {
  assert.equal(directionForKey('ArrowLeft'), 'prev');
  assert.equal(directionForKey('ArrowUp'), 'prev');
});

test('maps Actor next navigation keys', () => {
  assert.equal(directionForKey('ArrowRight'), 'next');
  assert.equal(directionForKey('ArrowDown'), 'next');
  assert.equal(directionForKey(' '), 'next');
});

test('ignores keys that are not Actor navigation shortcuts', () => {
  assert.equal(directionForKey('Enter'), null);
  assert.equal(directionForKey('PageDown'), null);
  assert.equal(directionForKey('a'), null);
});
