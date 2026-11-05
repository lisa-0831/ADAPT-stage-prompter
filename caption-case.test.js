const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { toSentenceCase } = require('./caption-case');

const client = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8');

test('turns an all-caps cue into sentence case', () => {
  assert.equal(
    toSentenceCase('OH NO, I COULDN’T. I DIDN’T MEAN TO – IS SHE OKAY?'),
    'Oh no, I couldn’t. I didn’t mean to – is she okay?',
  );
  assert.equal(
    toSentenceCase('I’M ALL RIGHT. THE POPPIES HERE IN OZ HAVE HEALING POWERS.'),
    'I’m all right. The poppies here in oz have healing powers.',
  );
  assert.equal(
    toSentenceCase('GLINDA AND I WILL GO'),
    'Glinda and I will go',
  );
});

test('capitalizes I contractions with either apostrophe', () => {
  assert.equal(toSentenceCase("I'VE THOROUGHLY EXAMINED HER"), "I've thoroughly examined her");
  assert.equal(toSentenceCase('I’LL GET YOU'), 'I’ll get you');
});

test('leaves an empty cue empty', () => {
  assert.equal(toSentenceCase(''), '');
});

test('the case toggle is controller-only and does not restyle character names', () => {
  assert.match(client, /<script src="caption-case\.js"><\/script>/);
  assert.match(client, /id="btn-case"/);
  assert.match(client, /isController && sentenceCase/);
  assert.match(client, /CaptionCase\.toSentenceCase/);
  assert.match(client, /\.char-name\s*\{[^}]*text-transform:\s*uppercase/);
  assert.match(client, /nameEl\.textContent = showName \? speaker : ''/);
});
