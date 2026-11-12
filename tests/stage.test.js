const test = require('node:test');
const assert = require('node:assert/strict');

const { createStage } = require('../public/stage');
const ScriptLibrary = require('../script-library-model');

const SCRIPT_ID = '11111111-1111-4111-8111-111111111111';
const ASSET_ID = '22222222-2222-4222-8222-222222222222';

test('resolves legacy paths and production asset urls', () => {
  const stage = createStage({ library: ScriptLibrary });
  const reference = `library:${SCRIPT_ID}/${ASSET_ID}`;
  assert.equal(stage.imageUrl('images/Title_Card.jpeg'), 'images/Title_Card.jpeg');
  assert.equal(
    stage.imageUrl(reference),
    `/api/live/assets/${SCRIPT_ID}/${ASSET_ID}`,
  );
  assert.equal(stage.imageUrl(''), '');
  assert.equal(stage.imageUrl('images/../secret.txt'), '');
});

test('image resolution stays inside the stage that received the library', () => {
  const first = createStage({
    library: {
      parseImageReference() { return { kind: 'legacy', path: 'images/first.jpg' }; },
      liveAssetUrl() { return '/first'; },
    },
  });
  const second = createStage({
    library: {
      parseImageReference() { return { kind: 'library', scriptId: 'a', assetId: 'b' }; },
      liveAssetUrl(scriptId, assetId) { return `/second/${scriptId}/${assetId}`; },
    },
  });
  assert.equal(first.imageUrl('anything'), 'images/first.jpg');
  assert.equal(second.imageUrl('anything'), '/second/a/b');
});
