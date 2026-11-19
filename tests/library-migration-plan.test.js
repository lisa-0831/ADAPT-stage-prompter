const test = require('node:test');
const assert = require('node:assert/strict');
const { hashText } = require('../script-library');
const { parseImageReference } = require('../script-library-model');
const { parseScript } = require('../script-format');
const {
  HISTORICAL_IMAGE_NOTE,
  planMigration,
} = require('../library-migration-plan');

const WELCOME = '2d0f0937-fc36-4d27-a31e-d047c2fd5623';
const TEST_SHOW = 'ee04e849-90d4-4eeb-b2a6-562b06067a32';
const WELCOME_V1 = '11111111-1111-4111-8111-111111111111';
const WELCOME_V2 = '11111111-1111-4111-8111-111111111112';
const TEST_V1 = '22222222-2222-4222-8222-222222222221';
const TEST_V2 = '22222222-2222-4222-8222-222222222222';
const CARD_WELCOME = '33333333-3333-4333-8333-333333333331';
const CARD_TEST = '33333333-3333-4333-8333-333333333332';
const BACK_WELCOME = '44444444-4444-4444-8444-444444444441';

function production({ id, text, v1, v2, assets }) {
  return {
    id,
    text,
    versions: { v1, v2 },
    assets: assets || {},
  };
}

function welcomeText(image = 'images/Title_Card.jpeg') {
  return `# WELCOME\n{AN IMMERSIVE}\n@image: ${image}\n---\n# Later\n@image: ${image}\nSee images/Title_Card.jpeg in the dialogue.\n`;
}

function testText() {
  return welcomeText().replace('{AN IMMERSIVE}', '{AN IMMERSIVe}');
}

function pair(options = {}) {
  const welcome = options.welcomeText !== undefined ? options.welcomeText : welcomeText();
  const other = options.testText !== undefined ? options.testText : testText();
  return {
    liveScript: options.liveScript !== undefined ? options.liveScript : welcome,
    liveId: options.liveId !== undefined ? options.liveId : WELCOME,
    productions: options.productions || [
      production({
        id: WELCOME,
        text: welcome,
        v1: WELCOME_V1,
        v2: WELCOME_V2,
        assets: { 'Title_Card.jpeg': CARD_WELCOME, ...(options.welcomeAssets || {}) },
      }),
      production({
        id: TEST_SHOW,
        text: other,
        v1: TEST_V1,
        v2: TEST_V2,
        assets: { 'Title_Card.jpeg': CARD_TEST, ...(options.testAssets || {}) },
      }),
    ],
  };
}

function saved(plan, id) {
  return plan.productions.find((production) => production.id === id);
}

test('a unique live-script hash selects that production', () => {
  const plan = planMigration(pair());
  assert.equal(plan.ok, true);
  assert.equal(plan.liveProductionId, WELCOME);
  assert.equal(plan.pointer.productionId, WELCOME);
  assert.equal(plan.pointer.versionId, WELCOME_V2);
  assert.equal(plan.pointer.contentHash, hashText(saved(plan, WELCOME).versions.v2.text));
  assert.equal(plan.warnings.length, 0);
  assert.equal(plan.activation.commit, false);
});

test('a stale library live id does not change the selected production', () => {
  const plan = planMigration(pair({ liveId: TEST_SHOW }));
  assert.equal(plan.ok, true);
  assert.equal(plan.liveProductionId, WELCOME);
  assert.equal(plan.pointer.productionId, WELCOME);
  assert.equal(plan.pointer.versionId, WELCOME_V2);
  assert.equal(plan.warnings.length, 1);
  assert.equal(plan.warnings[0].code, 'live-id-drift');
  assert.equal(plan.warnings[0].libraryLiveId, TEST_SHOW);
  assert.equal(plan.warnings[0].actualProductionId, WELCOME);
  assert.equal(saved(plan, TEST_SHOW).id, TEST_SHOW);
});

test('no matching production is a blocking error', () => {
  const plan = planMigration(pair({ liveScript: '# Somewhere else\nHello\n' }));
  assert.equal(plan.ok, false);
  assert.equal(plan.errors[0].code, 'no-live-match');
  assert.equal(plan.pointer, undefined);
  assert.equal(plan.activation.commit, false);
});

test('two matching productions are a blocking ambiguity error', () => {
  const same = welcomeText();
  const plan = planMigration({
    liveScript: same,
    liveId: WELCOME,
    productions: [
      production({
        id: WELCOME,
        text: same,
        v1: WELCOME_V1,
        v2: WELCOME_V2,
        assets: { 'Title_Card.jpeg': CARD_WELCOME },
      }),
      production({
        id: TEST_SHOW,
        text: same,
        v1: TEST_V1,
        v2: TEST_V2,
        assets: { 'Title_Card.jpeg': CARD_TEST },
      }),
    ],
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.errors[0].code, 'ambiguous-live-match');
  assert.deepEqual(plan.errors[0].productionIds, [WELCOME, TEST_SHOW]);
  assert.equal(plan.pointer, undefined);
});

test('original v1 bytes stay identical to the input', () => {
  const text = welcomeText();
  const bytes = Buffer.from(text, 'utf8');
  const plan = planMigration(pair({
    liveScript: bytes,
    welcomeText: bytes,
    testText: Buffer.from(testText(), 'utf8'),
  }));
  const version = saved(plan, WELCOME).versions.v1;
  assert.equal(plan.ok, true);
  assert.equal(version.text, text);
  assert.equal(version.contentHash, hashText(text));
  assert.equal(Buffer.from(version.text, 'utf8').equals(bytes), true);
  assert.equal(version.origin, 'original');
  assert.equal(version.parentVersionId, null);
});

test('v2 rewrites legacy image lines and leaves the surrounding text', () => {
  const plan = planMigration(pair());
  const migrated = saved(plan, WELCOME).versions.v2.text;
  const reference = `library:${WELCOME}/${CARD_WELCOME}`;
  assert.equal(migrated.includes('@image: images/'), false);
  assert.equal(migrated.split(`@image: ${reference}`).length - 1, 2);
  assert.equal(migrated.includes('{AN IMMERSIVE}'), true);
  assert.equal(migrated.includes('See images/Title_Card.jpeg in the dialogue.'), true);
  assert.equal(migrated.includes('\n---\n'), true);
  const slides = parseScript(migrated);
  assert.equal(parseImageReference(slides[0].titleImage).kind, 'library');
  assert.equal(parseImageReference(slides[1].titleImage).assetId, CARD_WELCOME);
  const spaced = planMigration(pair({
    welcomeText: '# WELCOME\n  @image: images/Title_Card.jpeg  \n',
    testText: '# TEST\nHello\n',
    liveScript: '# WELCOME\n  @image: images/Title_Card.jpeg  \n',
  }));
  assert.equal(
    saved(spaced, WELCOME).versions.v2.text,
    `# WELCOME\n  @image: library:${WELCOME}/${CARD_WELCOME}  \n`,
  );
});

test('v1 and v2 hashes differ when the bytes differ', () => {
  const plan = planMigration(pair());
  const versions = saved(plan, WELCOME).versions;
  assert.notEqual(versions.v1.text, versions.v2.text);
  assert.equal(versions.v1.contentHash, hashText(versions.v1.text));
  assert.equal(versions.v2.contentHash, hashText(versions.v2.text));
  assert.notEqual(versions.v1.contentHash, versions.v2.contentHash);
  assert.equal(plan.pointer.contentHash, versions.v2.contentHash);
});

test('the one-character WELCOME and Test spellings both survive', () => {
  const plan = planMigration(pair());
  const welcome = saved(plan, WELCOME);
  const other = saved(plan, TEST_SHOW);
  [welcome.versions.v1.text, welcome.versions.v2.text].forEach((text) => {
    assert.equal(text.includes('{AN IMMERSIVE}'), true);
    assert.equal(text.includes('{AN IMMERSIVe}'), false);
  });
  [other.versions.v1.text, other.versions.v2.text].forEach((text) => {
    assert.equal(text.includes('{AN IMMERSIVe}'), true);
    assert.equal(text.includes('{AN IMMERSIVE}\n'), false);
  });
  assert.notEqual(welcome.versions.v1.contentHash, other.versions.v1.contentHash);
  assert.equal(plan.pointer.productionId, WELCOME);
});

test('two Title Card lines in one production share one asset id', () => {
  const plan = planMigration(pair());
  const welcome = saved(plan, WELCOME);
  assert.deepEqual(welcome.assetMappings, [{
    legacyPath: 'images/Title_Card.jpeg',
    name: 'Title_Card.jpeg',
    assetId: CARD_WELCOME,
  }]);
  assert.deepEqual(welcome.versions.v2.assetIds, [CARD_WELCOME]);
  assert.equal(welcome.versions.v2.parentVersionId, WELCOME_V1);
  assert.equal(welcome.headVersionId, WELCOME_V2);
});

test('two productions receive distinct proposed asset ids', () => {
  const plan = planMigration(pair());
  const welcome = saved(plan, WELCOME);
  const other = saved(plan, TEST_SHOW);
  assert.equal(welcome.assetMappings[0].assetId, CARD_WELCOME);
  assert.equal(other.assetMappings[0].assetId, CARD_TEST);
  assert.equal(welcome.versions.v2.text.includes(CARD_TEST), false);
  assert.equal(other.versions.v2.text.includes(CARD_WELCOME), false);
  const forced = planMigration({
    liveScript: welcomeText(),
    liveId: WELCOME,
    productions: [
      production({
        id: WELCOME,
        text: welcomeText(),
        v1: WELCOME_V1,
        v2: WELCOME_V2,
        assets: { 'Title_Card.jpeg': CARD_WELCOME },
      }),
      production({
        id: TEST_SHOW,
        text: testText(),
        v1: TEST_V1,
        v2: TEST_V2,
        assets: { 'Title_Card.jpeg': CARD_WELCOME },
      }),
    ],
  });
  assert.equal(forced.ok, false);
  assert.equal(forced.errors.some((error) => error.code === 'shared-asset-id'), true);
  assert.equal(forced.pointer, undefined);
});

test('a missing image mapping fails without a pointer', () => {
  const plan = planMigration({
    liveScript: welcomeText(),
    liveId: WELCOME,
    productions: [
      production({
        id: WELCOME,
        text: welcomeText(),
        v1: WELCOME_V1,
        v2: WELCOME_V2,
        assets: {},
      }),
    ],
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.errors[0].code, 'missing-asset-mapping');
  assert.equal(plan.errors[0].legacyPath, 'images/Title_Card.jpeg');
  assert.equal(plan.pointer, undefined);
  assert.equal(JSON.stringify(plan).includes(CARD_WELCOME), false);
});

test('an invalid or unsafe image path is rejected', () => {
  const unsafe = '# Scene\n@image: images/../server.js\n';
  const plan = planMigration({
    liveScript: unsafe,
    productions: [
      production({
        id: WELCOME,
        text: unsafe,
        v1: WELCOME_V1,
        v2: WELCOME_V2,
        assets: { '../server.js': CARD_WELCOME },
      }),
    ],
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.errors[0].code, 'unsafe-image-path');
  assert.equal(plan.pointer, undefined);
  const dotted = planMigration({
    liveScript: '# Scene\n@image: images/..\n',
    productions: [
      production({
        id: WELCOME,
        text: '# Scene\n@image: images/..\n',
        v1: WELCOME_V1,
        v2: WELCOME_V2,
        assets: {},
      }),
    ],
  });
  assert.equal(dotted.ok, false);
  assert.equal(dotted.errors[0].code, 'unsafe-image-path');
});

test('existing library references stay in place and foreign ones fail', () => {
  const own = `library:${WELCOME}/${BACK_WELCOME}`;
  const text = `# WELCOME\n@image: ${own}\n@image: images/Title_Card.jpeg\n`;
  const plan = planMigration({
    liveScript: text,
    liveId: WELCOME,
    productions: [
      production({
        id: WELCOME,
        text,
        v1: WELCOME_V1,
        v2: WELCOME_V2,
        assets: { 'Title_Card.jpeg': CARD_WELCOME },
      }),
    ],
  });
  assert.equal(plan.ok, true);
  assert.equal(saved(plan, WELCOME).versions.v1.text, text);
  assert.equal(saved(plan, WELCOME).versions.v2.text.includes(`@image: ${own}`), true);
  assert.equal(saved(plan, WELCOME).versions.v2.text.includes(`library:${WELCOME}/${CARD_WELCOME}`), true);
  assert.deepEqual(saved(plan, WELCOME).versions.v2.assetIds, [BACK_WELCOME, CARD_WELCOME]);
  const libraryOnly = `# WELCOME\n@image: ${own}\n`;
  const unchanged = planMigration({
    liveScript: libraryOnly,
    productions: [
      production({
        id: WELCOME,
        text: libraryOnly,
        v1: WELCOME_V1,
        v2: WELCOME_V2,
      }),
    ],
  });
  assert.equal(unchanged.ok, true);
  assert.equal(saved(unchanged, WELCOME).versions.v2, null);
  assert.equal(saved(unchanged, WELCOME).headVersionId, WELCOME_V1);
  assert.equal(unchanged.pointer.versionId, WELCOME_V1);
  const foreign = `# WELCOME\n@image: library:${TEST_SHOW}/${CARD_TEST}\n`;
  const rejected = planMigration({
    liveScript: foreign,
    productions: [
      production({
        id: WELCOME,
        text: foreign,
        v1: WELCOME_V1,
        v2: WELCOME_V2,
      }),
    ],
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.errors[0].code, 'foreign-library-image');
});

test('CRLF and LF inputs keep their own line endings', () => {
  const lf = '# Scene\n{AN IMMERSIVE}\n@image: images/Title_Card.jpeg\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  const asPlan = (text) => planMigration({
    liveScript: text,
    productions: [
      production({
        id: WELCOME,
        text,
        v1: WELCOME_V1,
        v2: WELCOME_V2,
        assets: { 'Title_Card.jpeg': CARD_WELCOME },
      }),
    ],
  });
  const lfPlan = asPlan(lf);
  const crlfPlan = asPlan(crlf);
  assert.equal(saved(lfPlan, WELCOME).versions.v1.text, lf);
  assert.equal(saved(lfPlan, WELCOME).versions.v2.text.includes('\r'), false);
  assert.equal(saved(lfPlan, WELCOME).versions.v2.text.includes('@image: library:'), true);
  assert.equal(lfPlan.warnings.some((warning) => warning.code === 'cr-line-endings'), false);
  assert.equal(saved(crlfPlan, WELCOME).versions.v1.text, crlf);
  assert.equal(saved(crlfPlan, WELCOME).versions.v2.text.includes('\r\n'), true);
  assert.equal(
    saved(crlfPlan, WELCOME).versions.v2.text,
    crlf.replace('@image: images/Title_Card.jpeg', `@image: library:${WELCOME}/${CARD_WELCOME}`),
  );
  assert.equal(crlfPlan.warnings.some((warning) => warning.code === 'cr-line-endings'), true);
  assert.equal(parseImageReference(parseScript(saved(crlfPlan, WELCOME).versions.v2.text)[0].titleImage).kind, 'library');
});

test('a script with no legacy images does not invent a second version', () => {
  const text = '# Scene\nHello\n';
  const plan = planMigration({
    liveScript: text,
    liveId: WELCOME,
    productions: [
      production({
        id: WELCOME,
        text,
        v1: WELCOME_V1,
        v2: WELCOME_V2,
      }),
    ],
  });
  const welcome = saved(plan, WELCOME);
  assert.equal(plan.ok, true);
  assert.equal(welcome.versions.v2, null);
  assert.equal(welcome.headVersionId, WELCOME_V1);
  assert.equal(welcome.versions.v1.text, text);
  assert.equal(welcome.versions.v1.contentHash, hashText(text));
  assert.equal(welcome.historicalImages.length, 0);
  assert.equal(welcome.assetMappings.length, 0);
  assert.equal(plan.pointer.versionId, WELCOME_V1);
  assert.equal(plan.pointer.origin, 'original');
  assert.equal(plan.pointer.contentHash, welcome.versions.v1.contentHash);
});

test('the same injected inputs produce the same plan', () => {
  const input = pair({ liveId: TEST_SHOW });
  const snapshot = JSON.parse(JSON.stringify(input));
  const first = planMigration(input);
  const second = planMigration(input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(first, second);
  assert.equal(first.productions[0].historicalImages[0].byteSnapshot, false);
  assert.equal(first.productions[0].historicalImages[0].note, HISTORICAL_IMAGE_NOTE);
  assert.equal(first.productions[0].historicalImages[0].dependency, 'shared-images');
});
