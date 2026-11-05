const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseScript, positionAfterScriptReplace } = require('./script-format');
const ScriptEditor = require('./script-editor-model');

const scriptPath = path.join(__dirname, 'script.txt');
const scriptText = fs.readFileSync(scriptPath, 'utf8');

function memoryStorage() {
  const map = new Map();
  const keys = [];
  return {
    get length() { return keys.length; },
    key(index) { return keys[index] || null; },
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) {
      if (!map.has(key)) keys.push(key);
      map.set(key, String(value));
    },
    removeItem(key) {
      if (!map.has(key)) return;
      map.delete(key);
      keys.splice(keys.indexOf(key), 1);
    },
  };
}

function findLine(model, kind, predicate) {
  for (let sceneIndex = 0; sceneIndex < model.scenes.length; sceneIndex += 1) {
    const scene = model.scenes[sceneIndex];
    for (let lineIndex = 0; lineIndex < scene.lines.length; lineIndex += 1) {
      const entry = scene.lines[lineIndex];
      if (entry.kind === kind && (!predicate || predicate(entry))) {
        return { sceneIndex, lineIndex, entry };
      }
    }
  }
  return null;
}

test('opening and saving an unchanged script keeps its text and structure', () => {
  const model = ScriptEditor.load(scriptText);
  assert.equal(model.mode, 'scenes');
  assert.equal(ScriptEditor.serialize(model), scriptText);
  assert.deepEqual(parseScript(ScriptEditor.serialize(model)), parseScript(scriptText));

  const parsed = parseScript(scriptText);
  const workable = model.scenes.filter((scene) => scene.lines.some((entry) => entry.kind !== 'blank'));
  assert.equal(workable.length, parsed.length);
  workable.forEach((scene, index) => {
    const content = scene.lines.filter((entry) => (
      entry.kind === 'dialogue'
      || entry.kind === 'lyric'
      || entry.kind === 'singalong'
      || entry.kind === 'direction'
      || entry.kind === 'locked'
    ));
    assert.equal(content.length, parsed[index].lines.length, ScriptEditor.sceneTitle(scene));
    const title = scene.lines.find((entry) => entry.kind === 'title');
    if (title) assert.equal(title.value.trim(), parsed[index].title.trim());
    const images = scene.lines.filter((entry) => entry.kind === 'image');
    const imagePath = images.length ? images[images.length - 1].value.trim() : null;
    assert.equal(imagePath, parsed[index].titleImage);
  });

  const lyric = model.scenes
    .flatMap((scene) => scene.lines)
    .find((entry) => entry.kind === 'lyric' && !entry.readOnly && entry.prefix.includes('##'));
  assert.ok(lyric, 'expected an editable lyric line that keeps its ## mark');
});

test('editing dialogue leaves the other scene, lyrics, image, and speaker intact', () => {
  const original = [
    '# ONE',
    '@image: images/a.jpg',
    '## LA LA',
    'MIDDLE',
    'END ##',
    '[DOROTHY]',
    "I DON'T — I’M FINE.",
    '---',
    '# TWO',
    '[GULCH]',
    'GO AWAY.',
  ].join('\n');
  const model = ScriptEditor.load(original);
  const dialogue = findLine(model, 'dialogue', (entry) => entry.raw.includes("I DON'T"));
  assert.equal(
    ScriptEditor.setLineText(model, dialogue.sceneIndex, dialogue.lineIndex, 'HELLO FRIEND.'),
    true,
  );

  const scenes = ScriptEditor.serialize(model).split('\n---\n');
  const before = original.split('\n---\n');
  assert.equal(scenes[1], before[1]);
  assert.match(scenes[0], /@image: images\/a\.jpg/);
  assert.match(scenes[0], /## LA LA/);
  assert.match(scenes[0], /MIDDLE/);
  assert.match(scenes[0], /END ##/);
  assert.match(scenes[0], /\[DOROTHY\]/);
  assert.doesNotMatch(scenes[0], /I DON'T/);

  const parsed = parseScript(ScriptEditor.serialize(model));
  const edited = parsed[0].lines.find((entry) => entry.text === 'HELLO FRIEND.');
  assert.equal(edited.speaker, 'DOROTHY');
  assert.equal(parsed[1].lines[0].text, 'GO AWAY.');
  assert.equal(parsed[1].lines[0].speaker, 'GULCH');
  assert.equal(parsed[0].titleImage, 'images/a.jpg');
});

test('editing a stage direction keeps the braces and nearby capitalization', () => {
  const original = '# S\n{A DOG BARKS}\nGo Away.\n';
  const model = ScriptEditor.load(original);
  const direction = findLine(model, 'direction');
  assert.equal(direction.entry.value, 'A DOG BARKS');
  ScriptEditor.setLineText(model, direction.sceneIndex, direction.lineIndex, 'A CAT MEOWS');
  const saved = ScriptEditor.serialize(model);
  assert.match(saved, /\{A CAT MEOWS\}/);
  assert.match(saved, /Go Away\./);
  assert.equal(parseScript(saved)[0].lines[0].text, '{A CAT MEOWS}');
});

test('editing lyric text keeps the ## marks', () => {
  const model = ScriptEditor.load('# S\n## LA LA\nEND ##\n');
  const opening = findLine(model, 'lyric', (entry) => entry.raw.startsWith('##'));
  assert.equal(opening.entry.prefix, '## ');
  assert.equal(opening.entry.value, 'LA LA');
  ScriptEditor.setLineText(model, opening.sceneIndex, opening.lineIndex, 'LA LA LA');
  assert.equal(ScriptEditor.serialize(model), '# S\n## LA LA LA\nEND ##\n');
});

test('read-only lines and unknown text are not deleted when another line changes', () => {
  const original = '# ONE\n[DOROTHY\nHELLO\n---\n# TWO\n*THE WITCH CACKLES*\nFINE\n';
  const model = ScriptEditor.load(original);
  const locked = findLine(model, 'locked');
  assert.equal(locked.entry.readOnly, true);
  assert.equal(ScriptEditor.setLineText(model, locked.sceneIndex, locked.lineIndex, 'GONE'), false);
  const fine = findLine(model, 'dialogue', (entry) => entry.raw === 'FINE');
  ScriptEditor.setLineText(model, fine.sceneIndex, fine.lineIndex, 'OK');
  const saved = ScriptEditor.serialize(model);
  assert.match(saved, /\[DOROTHY/);
  assert.match(saved, /\*THE WITCH CACKLES\*/);
  assert.match(saved, /HELLO/);
  assert.match(saved, /OK/);
});

test('speaker edits keep the following line attached', () => {
  const model = ScriptEditor.load('# S\n[A] & [B]\nHI\n');
  const speaker = findLine(model, 'speaker');
  assert.deepEqual(speaker.entry.names, ['A', 'B']);
  assert.equal(ScriptEditor.setSpeakerName(model, speaker.sceneIndex, speaker.lineIndex, 1, 'C]'), false);
  assert.equal(ScriptEditor.setSpeakerName(model, speaker.sceneIndex, speaker.lineIndex, 1, 'C'), true);
  const saved = ScriptEditor.serialize(model);
  assert.match(saved, /\[A\] & \[C\]/);
  assert.equal(parseScript(saved)[0].lines[0].speaker, 'A & C');
  assert.equal(parseScript(saved)[0].lines[0].text, 'HI');
});

test('validation blocks empty scripts and warns on fixable problems', () => {
  assert.equal(ScriptEditor.validate('   ').errors[0].code, 'empty');
  assert.equal(ScriptEditor.validate('\n---\n').errors[0].code, 'no-scenes');
  assert.equal(ScriptEditor.load('\n---\n').mode, 'raw');
  assert.equal(ScriptEditor.serialize(ScriptEditor.load('\n---\n')), '\n---\n');

  const apostrophe = "# SCENE\n[DOROTHY]\nI DON'T — I’M FINE.\n";
  assert.equal(ScriptEditor.validate(apostrophe).errors.length, 0);

  const unclosedLyric = ScriptEditor.validate('# S\n## HELLO\nMORE\n');
  assert.equal(unclosedLyric.errors.length, 0);
  assert.ok(unclosedLyric.warnings.some((warning) => warning.code === 'unclosed-lyric'));

  const unclosedSing = ScriptEditor.validate('# S\n<HELLO\nMORE\n');
  assert.equal(unclosedSing.errors.length, 0);
  assert.ok(unclosedSing.warnings.some((warning) => warning.code === 'unclosed-singalong'));

  const malformed = ScriptEditor.validate('# S\n[DOROTHY\nHELLO\n');
  assert.equal(malformed.errors.length, 0);
  assert.ok(malformed.warnings.some((warning) => warning.code === 'malformed-speaker'));

  const longLine = 'A'.repeat(ScriptEditor.LONG_LINE + 1);
  const long = ScriptEditor.validate(`# S\n${longLine}\n`);
  assert.equal(long.errors.length, 0);
  assert.ok(long.warnings.some((warning) => warning.code === 'long-line'));

  const extra = ScriptEditor.validate('# ONE\nHello\n# TWO\n');
  assert.equal(extra.errors.length, 0);
  assert.ok(extra.warnings.some((warning) => warning.code === 'extra-heading'));

  const lyrics = ScriptEditor.validate('# S\n## TWO\nEND ##\n');
  assert.equal(lyrics.warnings.some((warning) => warning.code === 'extra-heading'), false);
  assert.equal(lyrics.warnings.some((warning) => warning.code === 'unclosed-lyric'), false);

  const blankName = ScriptEditor.validate('# S\n[]\nHI\n');
  assert.ok(blankName.errors.some((error) => error.code === 'empty-speaker'));

  const legacy = ScriptEditor.validate(scriptText);
  assert.deepEqual(legacy.errors, []);
  assert.deepEqual(
    legacy.warnings.map((warning) => warning.code),
    ['long-line'],
  );
});

test('a draft stays separate from the published script and stale drafts do not load', () => {
  const published = '# LIVE\nHello\n';
  let live = published;
  const model = ScriptEditor.load('# DRAFT\nEdited\n');
  ScriptEditor.setLineText(model, 0, 1, 'Changed');
  assert.equal(live, published);
  assert.notEqual(ScriptEditor.serialize(model), live);

  const storage = memoryStorage();
  const saved = ScriptEditor.saveDraft(storage, {
    baseRevision: 'rev-a',
    scriptText: ScriptEditor.serialize(model),
    savedAt: '2026-10-29T00:00:00.000Z',
  });
  assert.equal(saved.ok, true);
  ScriptEditor.saveDraft(storage, {
    baseRevision: 'rev-b',
    scriptText: 'other draft',
    savedAt: '2026-10-29T00:00:00.000Z',
  });

  assert.equal(ScriptEditor.loadDraft(storage, 'rev-a').scriptText, ScriptEditor.serialize(model));
  assert.equal(ScriptEditor.loadDraft(storage, 'rev-b').scriptText, 'other draft');
  assert.equal(ScriptEditor.loadDraft(storage, 'rev-c'), null);
  assert.equal(ScriptEditor.listStaleDrafts(storage, 'rev-b').length, 1);
  assert.equal(ScriptEditor.listStaleDrafts(storage, 'rev-b')[0].scriptText, ScriptEditor.serialize(model));

  storage.setItem(
    ScriptEditor.draftKey('rev-new'),
    JSON.stringify({ baseRevision: 'rev-old', scriptText: 'stale', savedAt: 't' }),
  );
  assert.equal(ScriptEditor.loadDraft(storage, 'rev-new'), null);
  assert.equal(ScriptEditor.deleteStaleDrafts(storage, 'rev-b') > 0, true);
  assert.equal(ScriptEditor.loadDraft(storage, 'rev-a'), null);
  assert.ok(ScriptEditor.loadDraft(storage, 'rev-b'));
});

test('drafts for different saved scripts do not replace each other', () => {
  const storage = memoryStorage();
  ScriptEditor.saveDraft(storage, {
    scriptId: '11111111-1111-4111-8111-111111111111',
    baseRevision: 'rev-1',
    scriptText: '# One\nAlpha\n',
    savedAt: '2026-11-05T00:00:00.000Z',
  });
  ScriptEditor.saveDraft(storage, {
    scriptId: '22222222-2222-4222-8222-222222222222',
    baseRevision: 'rev-1',
    scriptText: '# Two\nBeta\n',
    savedAt: '2026-11-05T00:00:00.000Z',
  });
  ScriptEditor.saveDraft(storage, {
    scriptId: '11111111-1111-4111-8111-111111111111',
    baseRevision: 'rev-2',
    scriptText: '# One\nEdited\n',
    savedAt: '2026-11-05T00:00:00.000Z',
  });

  assert.equal(
    ScriptEditor.loadDraft(storage, 'rev-1', '11111111-1111-4111-8111-111111111111').scriptText,
    '# One\nAlpha\n',
  );
  assert.equal(
    ScriptEditor.loadDraft(storage, 'rev-1', '22222222-2222-4222-8222-222222222222').scriptText,
    '# Two\nBeta\n',
  );
  assert.equal(ScriptEditor.loadDraft(storage, 'rev-1', '22222222-2222-4222-8222-222222222222').scriptText.includes('Alpha'), false);
  assert.equal(ScriptEditor.listStaleDrafts(storage, 'rev-2', '11111111-1111-4111-8111-111111111111').length, 1);
  assert.equal(ScriptEditor.deleteStaleDrafts(storage, 'rev-2', '11111111-1111-4111-8111-111111111111'), 1);
  assert.equal(ScriptEditor.loadDraft(storage, 'rev-1', '11111111-1111-4111-8111-111111111111'), null);
  assert.ok(ScriptEditor.loadDraft(storage, 'rev-1', '22222222-2222-4222-8222-222222222222'));
  assert.ok(ScriptEditor.loadDraft(storage, 'rev-2', '11111111-1111-4111-8111-111111111111'));
});

test('publication waits for server confirmation and ignores a repeated publish', () => {
  assert.equal(ScriptEditor.publicationStatus(false, { ok: true, revision: 'abc' }).success, false);
  const acknowledged = ScriptEditor.publicationStatus(true, { ok: true, slides: 10 });
  assert.equal(acknowledged.success, true);
  assert.equal(acknowledged.revision, null);
  assert.equal(ScriptEditor.publishOutcome(acknowledged).closeEditor, true);
  assert.equal(ScriptEditor.publicationStatus(true, { ok: false, revision: 'abc' }).success, false);
  const success = ScriptEditor.publicationStatus(true, { ok: true, revision: 'abc' });
  assert.equal(success.success, true);
  assert.equal(success.revision, 'abc');
  assert.match(success.message, /Published/);

  const first = ScriptEditor.stagePublishedScript('old', 'new', '');
  assert.equal(first.changed, true);
  assert.equal(first.previousText, 'old');
  const repeat = ScriptEditor.stagePublishedScript('new', 'new', first.previousText);
  assert.equal(repeat.changed, false);
  assert.equal(repeat.previousText, 'old');
  assert.equal(ScriptEditor.stagePublishedScript('old', '   ', '').ok, false);

  const guard = ScriptEditor.createPublishGuard();
  assert.equal(guard.tryStart(), true);
  assert.equal(guard.tryStart(), false);
  guard.finish();
  assert.equal(guard.tryStart(), true);
});

test('publish confirmation can be opened and cancelled without publishing', () => {
  const content = ScriptEditor.publishConfirmContent([
    { message: 'Scene 7 has a very long dialogue line (435 characters). It will still be published.' },
    { message: 'Scene 7 has a very long dialogue line (435 characters). It will still be published.' },
  ], { liveChanged: true });
  assert.equal(content.title, 'Publish this script?');
  assert.equal(
    content.message,
    'This will update the script on all connected Controller, Actor, and Audience screens.',
  );
  assert.equal(content.notes.length, 4);
  assert.deepEqual(content.warnings, [
    'Scene 7 has a very long dialogue line (435 characters). It will still be published.',
  ]);
  assert.equal(ScriptEditor.confirmCancelFocusId('publish'), 'editor-publish');
  assert.equal(ScriptEditor.publishRequestState(false).allowDismiss, true);
});

test('a publish request shows Publishing and ignores a second start', () => {
  const idle = ScriptEditor.publishRequestState(false);
  const pending = ScriptEditor.publishRequestState(true);
  assert.equal(idle.label, 'Publish Now');
  assert.equal(idle.busy, false);
  assert.equal(pending.label, 'Publishing...');
  assert.equal(pending.busy, true);
  assert.equal(pending.allowDismiss, false);
  const guard = ScriptEditor.createPublishGuard();
  assert.equal(guard.tryStart(), true);
  assert.equal(guard.tryStart(), false);
  guard.finish();
  assert.equal(guard.tryStart(), true);
});

test('successful publication closes both views and a failure keeps the editor', () => {
  const published = ScriptEditor.publishOutcome({ success: true, revision: 'abc' });
  assert.equal(published.ok, true);
  assert.equal(published.closeConfirm, true);
  assert.equal(published.closeEditor, true);
  assert.equal(published.clearDraft, true);
  assert.equal(published.message, 'Script published successfully.');
  assert.equal(
    ScriptEditor.publishLiveNotice(published.message, 'MUNCHKINLAND'),
    'Script published successfully. The live cue stayed on “MUNCHKINLAND”. This line looks the same when the edit is in another scene.',
  );
  assert.equal(ScriptEditor.publishLiveNotice(published.message, '  '), published.message);

  const failed = ScriptEditor.publishOutcome({
    success: false,
    message: 'The script was not published. The live show is unchanged.',
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.closeConfirm, false);
  assert.equal(failed.closeEditor, false);
  assert.equal(failed.clearDraft, false);
  assert.match(failed.message, /not published/);
  assert.equal(ScriptEditor.publishOutcome({ success: true }).closeEditor, true);
});

test('replacing a script keeps scene and line numbers only when they still exist', () => {
  const slides = [
    { lines: [{ text: 'a' }, { text: 'b' }] },
    { lines: [{ text: 'c' }] },
  ];
  assert.deepEqual(
    positionAfterScriptReplace(
      { slideIndex: 1, lineIndex: 4, showTitleImage: true, showLine: true },
      slides,
    ),
    { slideIndex: 1, lineIndex: 0, showTitleImage: true, showLine: true },
  );
  assert.deepEqual(
    positionAfterScriptReplace(
      { slideIndex: 3, lineIndex: 1, showTitleImage: false },
      [{ lines: ['only'] }],
    ),
    { slideIndex: 0, lineIndex: 0, showTitleImage: false, showLine: true },
  );
});

test('the controller page exposes Edit Script without removing Replace Script or actor follow-live', () => {
  const client = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8');
  const controller = client.slice(client.indexOf('<div id="controller">'), client.indexOf('<div id="actor-controls">'));
  assert.match(controller, /id="btn-edit-script"/);
  assert.match(controller, /id="btn-upload-toggle"/);
  assert.match(client, /id="script-editor"/);
  assert.match(client, /id="editor-save"/);
  assert.match(client, /id="editor-preview-btn"/);
  assert.match(client, /id="editor-publish"/);
  assert.match(client, /ScriptEditor\.publicationStatus/);
  assert.match(client, /ScriptEditor\.publishConfirmContent/);
  assert.match(client, /ScriptEditor\.publishOutcome/);
  assert.match(client, /ScriptEditor\.publishRequestState/);
  assert.match(client, /id="editor-confirm" hidden role="dialog" aria-modal="true"/);
  assert.equal(client.includes('<dialog id="editor-confirm"'), false);
  assert.match(client, /showConfirmFailure\(outcome\.message\)/);
  assert.match(client, /ScriptEditor\.publishLiveNotice/);
  assert.match(client, /if \(!isActor \|\| !scriptChanged\) render\(\)/);
  assert.match(client, /editorDom\.workspace\.inert = true/);
  assert.match(client, /isActor && scriptChanged/);
  assert.match(client, /ActorModeModel\.followLive\(\)/);
});
