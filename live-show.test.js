const test = require('node:test');
const assert = require('node:assert/strict');

const { createLiveShow } = require('./public/live-show');

function scriptMessage(overrides) {
  return Object.assign({
    slides: [{ title: 'Opening', lines: [{ text: 'Hello', speaker: '' }] }],
    revision: 'rev-1',
    liveScriptId: 'prod-1',
  }, overrides);
}

test('starts with an empty script and no live cue', () => {
  const show = createLiveShow();
  assert.deepEqual(show.getSlides(), []);
  assert.equal(show.getLiveState(), null);
  assert.equal(show.getRevision(), null);
  assert.equal(show.getLiveScriptId(), null);
});

test('stores a server script without treating the first revision as a change', () => {
  const show = createLiveShow();
  const message = scriptMessage();
  const result = show.applyScript(message);
  assert.deepEqual(result, { scriptChanged: false });
  assert.equal(show.getSlides(), message.slides);
  assert.equal(show.getRevision(), 'rev-1');
  assert.equal(show.getLiveScriptId(), 'prod-1');
  assert.equal(show.getLiveState(), null);
});

test('stores and clears the server live position without changing the script', () => {
  const show = createLiveShow();
  show.applyScript(scriptMessage());
  const position = { slideIndex: 1, lineIndex: 0, showTitleImage: true };
  show.applyState(position);
  assert.equal(show.getLiveState(), position);
  assert.equal(show.getRevision(), 'rev-1');
  show.applyState(null);
  assert.equal(show.getLiveState(), null);
  assert.equal(show.getSlides().length, 1);
});

test('a later script revision is a change and leaves the live cue for the caller', () => {
  const show = createLiveShow();
  show.applyScript(scriptMessage());
  const position = { slideIndex: 0, lineIndex: 0, showTitleImage: false };
  show.applyState(position);
  const nextSlides = [{ title: 'Next', lines: [] }];
  const changed = show.applyScript(scriptMessage({
    slides: nextSlides,
    revision: 'rev-2',
    liveScriptId: 'prod-2',
  }));
  assert.deepEqual(changed, { scriptChanged: true });
  assert.equal(show.getSlides(), nextSlides);
  assert.equal(show.getRevision(), 'rev-2');
  assert.equal(show.getLiveScriptId(), 'prod-2');
  assert.equal(show.getLiveState(), position);
  const same = show.applyScript({
    slides: nextSlides,
    revision: 'rev-2',
  });
  assert.deepEqual(same, { scriptChanged: false });
  assert.equal(show.getLiveScriptId(), 'prod-2');
});

test('updates the production id only when the caller or message supplies one', () => {
  const show = createLiveShow();
  show.applyScript(scriptMessage());
  show.setLiveScriptId('from-library');
  assert.equal(show.getLiveScriptId(), 'from-library');
  show.setLiveScriptId(null);
  assert.equal(show.getLiveScriptId(), null);
  show.setLiveScriptId('kept');
  show.applyScript(scriptMessage({ liveScriptId: undefined }));
  assert.equal(show.getLiveScriptId(), 'kept');
  show.applyScript(scriptMessage({ liveScriptId: null }));
  assert.equal(show.getLiveScriptId(), null);
  show.setLiveScriptId('kept-again');
  show.applyScript(scriptMessage({ liveScriptId: 0 }));
  assert.equal(show.getLiveScriptId(), 'kept-again');
  show.applyScript(scriptMessage({ liveScriptId: '' }));
  assert.equal(show.getLiveScriptId(), null);
});

test('stores a missing slide list as it arrived', () => {
  const show = createLiveShow();
  const result = show.applyScript({});
  assert.deepEqual(result, { scriptChanged: false });
  assert.equal(show.getSlides(), undefined);
  assert.equal(show.getRevision(), undefined);
  assert.equal(show.getLiveScriptId(), null);
});

test('separate live shows do not share script, cue, or production id', () => {
  const first = createLiveShow();
  const second = createLiveShow();
  first.applyScript(scriptMessage());
  first.applyState({ slideIndex: 0, lineIndex: 1 });
  first.setLiveScriptId('only-first');
  assert.deepEqual(second.getSlides(), []);
  assert.equal(second.getLiveState(), null);
  assert.equal(second.getRevision(), null);
  assert.equal(second.getLiveScriptId(), null);
  second.applyScript(scriptMessage({ revision: 'other', liveScriptId: 'only-second' }));
  assert.equal(first.getRevision(), 'rev-1');
  assert.equal(first.getLiveScriptId(), 'only-first');
  assert.equal(second.getLiveScriptId(), 'only-second');
});
