const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cueRevealOffset, DIRECTION_BLOCK_GAP } = require('./subtitle-layout');

const client = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8');
const stage = fs.readFileSync(path.join(__dirname, 'public/stage.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');

function parseCaption(role) {
  const block = styles.match(new RegExp(`html\\[data-role="${role}"\\]\\s*\\{([^}]+)\\}`));
  assert.ok(block, `missing caption rules for ${role}`);
  const sizes = block[1].match(
    /--caption-size:\s*clamp\(\s*([0-9.]+)rem\s*,\s*calc\(\s*([0-9.]+)rem\s*\+\s*min\(\s*([0-9.]+)cqw\s*,\s*([0-9.]+)cqh\s*\)\s*\)\s*,\s*([0-9.]+)rem\s*\)/,
  );
  assert.ok(sizes, `${role} caption size should use clamp, rem, and both container axes`);
  return {
    minRem: Number(sizes[1]),
    addRem: Number(sizes[2]),
    cqw: Number(sizes[3]),
    cqh: Number(sizes[4]),
    maxRem: Number(sizes[5]),
  };
}

function captionPx(spec, width, height, root = 16) {
  const preferred = spec.addRem * root + Math.min((width * spec.cqw) / 100, (height * spec.cqh) / 100);
  return Math.min(spec.maxRem * root, Math.max(spec.minRem * root, preferred));
}

test('caption size follows the stage box on both axes', () => {
  const audience = parseCaption('audience');
  const actor = parseCaption('actor');
  const controller = parseCaption('controller');

  assert.match(client, /<link rel="stylesheet" href="\/styles\.css">/);
  assert.doesNotMatch(client, /<style[\s>]/);
  assert.match(styles, /container:\s*stage\s*\/\s*size/);
  assert.match(styles, /overflow-wrap:\s*anywhere/);
  assert.match(client, /documentElement\.dataset\.role\s*=\s*role/);
  assert.doesNotMatch(styles, /font-size:\s*clamp\(1\.5rem,\s*3\.2vw,\s*2\.4rem\)/);
  assert.doesNotMatch(styles, /max-width:\s*160px/);
  assert.doesNotMatch(client, /addEventListener\(\s*['"]resize['"]/);

  const stage = { width: 1800, height: 980 };
  const audienceSize = captionPx(audience, stage.width, stage.height);
  const actorSize = captionPx(actor, stage.width, stage.height);
  const controllerSize = captionPx(controller, stage.width, stage.height);

  assert.ok(audienceSize >= 60 && audienceSize <= 72, `audience captions should stay in the comfortable projection range, got ${audienceSize}`);
  assert.ok(actorSize <= 56, `actor captions should stay within a desk or tablet reading size, got ${actorSize}`);
  assert.ok(controllerSize >= 40 && controllerSize <= 44, `controller captions should stay readable beside the controls, got ${controllerSize}`);
  assert.ok(audienceSize > actorSize);
  assert.ok(actorSize >= controllerSize);

  assert.ok(captionPx(audience, 2000, 420) < captionPx(audience, 2000, 1100));
  assert.ok(captionPx(audience, 420, 900) < captionPx(audience, 1000, 900));
});

test('captions stay readable on a phone and grow when text is enlarged', () => {
  for (const role of ['audience', 'actor', 'controller']) {
    const spec = parseCaption(role);
    const phone = captionPx(spec, 360, 760);
    assert.ok(phone >= 24, `${role} phone size ${phone}px is below 24px`);
    assert.ok(phone <= 52, `${role} phone size ${phone}px is too large for a narrow screen`);
    assert.ok(captionPx(spec, 360, 760, 32) > phone, `${role} should grow when the root font size doubles`);
  }
});

test('stage directions use a caption-relative gap instead of a root-em gap', () => {
  assert.equal(DIRECTION_BLOCK_GAP, '0.85em');
  assert.match(stage, /SubtitleLayout\.DIRECTION_BLOCK_GAP/);
  assert.doesNotMatch(styles, /2\.8em/);
});

test('a tall active cue is scrolled into view only when it is not already readable', () => {
  assert.equal(cueRevealOffset({
    stageTop: 10,
    stageBottom: 800,
    cueTop: 200,
    cueBottom: 500,
  }), 0);

  assert.equal(cueRevealOffset({
    stageTop: 0,
    stageBottom: 400,
    cueTop: 0,
    cueBottom: 1400,
  }), 0);

  assert.equal(cueRevealOffset({
    stageTop: 0,
    stageBottom: 400,
    cueTop: 40,
    cueBottom: 1400,
  }), 0);

  assert.equal(cueRevealOffset({
    stageTop: 0,
    stageBottom: 400,
    cueTop: 370,
    cueBottom: 900,
  }), 370);

  assert.equal(cueRevealOffset({
    stageTop: 0,
    stageBottom: 0,
    cueTop: 10,
    cueBottom: 40,
  }), 0);
});

test('lines before and after the current cue use the same paler ink', () => {
  assert.match(styles, /\.line-row\.past,\s*\.line-row\.future\s*\{[^}]*--idle-strength:\s*32%/);
  assert.match(styles, /\.line-row\.past \.script-line,\s*\.line-row\.future \.script-line\s*\{[^}]*color-mix\(in srgb, var\(--ink\) var\(--idle-strength\), var\(--bg\)\)/);
  assert.doesNotMatch(styles, /\.line-row\.past\s*\{\s*opacity:/);
  assert.doesNotMatch(stage, /future-\$\{ahead\}/);
});

test('layout keeps caption overflow inside the stage and preserves actor controls', () => {
  assert.match(styles, /#stage[\s\S]*?min-height:\s*0/);
  assert.match(styles, /#stage[\s\S]*?overflow-y:\s*auto/);
  assert.match(styles, /#lines-current[\s\S]*?flex:\s*0\s*0\s*auto/);
  assert.match(styles, /#lines-past[\s\S]*?overflow:\s*hidden/);
  assert.match(stage, /stage\.scrollTop\s*=\s*0/);
  assert.match(styles, /#actor-nav-buttons \.actor-action[\s\S]*?min-height:\s*64px/);
  assert.match(styles, /\.btn:focus-visible/);
  assert.match(styles, /--amber:\s*#f5c842/);
  assert.match(styles, /--bg:\s*#0a0a0a/);
});
