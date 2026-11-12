const test = require('node:test');
const assert = require('node:assert/strict');

const { lineType, displayText } = require('./public/text');

test('classifies a cue by its first marker', () => {
  assert.equal(lineType('HELLO THERE'), 'dialogue');
  assert.equal(lineType(''), 'dialogue');
  assert.equal(lineType('  {She exits.}'), 'direction');
  assert.equal(lineType('## Somewhere'), 'lyric');
  assert.equal(lineType('< Follow along >'), 'singalong');
  assert.equal(lineType('{<not a sing-along>}'), 'direction');
  assert.equal(lineType('## <not a sing-along>'), 'lyric');
});

test('strips direction, lyric, and sing-along markers without trimming dialogue', () => {
  assert.equal(displayText('  HELLO  ', 'dialogue'), '  HELLO  ');
  assert.equal(displayText('  {She exits.}  ', 'direction'), 'She exits.');
  assert.equal(displayText('{She exits', 'direction'), 'She exits');
  assert.equal(displayText('## Somewhere over ## the rainbow', 'lyric'), 'Somewhere over');
  assert.equal(displayText('## Somewhere', 'lyric'), 'Somewhere');
  assert.equal(displayText('< Follow along >', 'singalong'), 'Follow along');
  assert.equal(displayText('', 'direction'), '');
});
