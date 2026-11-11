(function (root, factory) {
  const scriptEditor = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = scriptEditor;
  } else {
    root.ScriptEditor = scriptEditor;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SCENE_SEPARATOR = '\n---\n';
  const DRAFT_PREFIX = 'prompter-script-draft:';
  const LONG_LINE = 400;
  const SPEAKER_LINE = /^\s*\[([^\]]+)\](?:\s*&\s*\[([^\]]+)\])?\s*$/;

  function splitSceneTexts(text) {
    const parts = [];
    let start = 0;
    for (;;) {
      const index = text.indexOf(SCENE_SEPARATOR, start);
      if (index === -1) {
        parts.push(text.slice(start));
        return parts;
      }
      parts.push(text.slice(start, index));
      start = index + SCENE_SEPARATOR.length;
    }
  }

  function blankLine(raw) {
    return {
      kind: 'blank',
      label: '',
      note: '',
      readOnly: true,
      raw,
      prefix: '',
      suffix: '',
      value: raw,
      baseline: raw,
      names: null,
      baselineNames: null,
      flags: [],
      reason: '',
    };
  }

  function line(fields) {
    return {
      kind: fields.kind,
      label: fields.label,
      note: fields.note,
      readOnly: !!fields.readOnly,
      raw: fields.raw,
      prefix: fields.prefix || '',
      suffix: fields.suffix || '',
      value: fields.value,
      baseline: fields.value,
      names: fields.names || null,
      baselineNames: fields.names ? fields.names.slice() : null,
      flags: fields.flags || [],
      reason: fields.reason || '',
    };
  }

  function faithful(raw, prefix, value, suffix) {
    if (prefix + value + suffix === raw) {
      return { prefix, value, suffix };
    }
    return { prefix: '', value: raw, suffix: '' };
  }

  function makeTitle(raw) {
    const match = raw.match(/^(\s*#+\s*)([\s\S]*)$/);
    const parts = match
      ? faithful(raw, match[1], match[2], '')
      : { prefix: '', value: raw, suffix: '' };
    return line({
      kind: 'title',
      label: 'Scene title',
      note: 'Shown at the top of the scene.',
      raw,
      ...parts,
    });
  }

  function makeImage(raw) {
    const match = raw.match(/^(\s*@image:\s*)([\s\S]*)$/);
    const parts = match
      ? faithful(raw, match[1], match[2], '')
      : { prefix: '', value: raw, suffix: '' };
    return line({
      kind: 'image',
      label: 'Scene image',
      note: 'Shown before the first line. Choose an image from this production, or keep an older images/filename.jpg line.',
      raw,
      ...parts,
    });
  }

  function makeSpeaker(raw) {
    const dual = raw.match(/^\s*\[([^\]]+)\]\s*&\s*\[([^\]]+)\]\s*$/);
    const single = raw.match(/^\s*\[([^\]]+)\]\s*$/);
    const names = dual ? [dual[1], dual[2]] : [single[1]];
    return line({
      kind: 'speaker',
      label: names.length === 2 ? 'Characters together' : 'Character name',
      note: names.length === 2
        ? 'Both names stay on this line and are shown together beside the next line.'
        : 'Shown beside the next line, until the next character name.',
      raw,
      value: names.join(' & '),
      names,
    });
  }

  function makeLocked(raw, reason) {
    const speaker = reason === 'speaker';
    return line({
      kind: 'locked',
      label: 'Kept as written',
      note: speaker
        ? 'This line looks like a character name but is not [NAME] or [NAME] & [NAME]. It is read-only so it will not be rewritten.'
        : 'This line starts with @ but is not an image line (@image: file). It is read-only so it will not be removed.',
      readOnly: true,
      raw,
      value: raw,
      reason,
    });
  }

  function lyricAffixes(raw) {
    if (/^\s*##/.test(raw) && /##\s*$/.test(raw)) {
      const both = raw.match(/^(\s*##\s*)([\s\S]*?)(\s*##\s*)$/);
      if (both) return { prefix: both[1], value: both[2], suffix: both[3] };
    }
    if (/^\s*##/.test(raw)) {
      const open = raw.match(/^(\s*##\s*)([\s\S]*)$/);
      return { prefix: open[1], value: open[2], suffix: '' };
    }
    if (/##\s*$/.test(raw)) {
      const close = raw.match(/^([\s\S]*?)(\s*##\s*)$/);
      return { prefix: '', value: close[1], suffix: close[2] };
    }
    return { prefix: '', value: raw, suffix: '' };
  }

  function singalongAffixes(raw) {
    if (/^\s*</.test(raw) && />\s*$/.test(raw)) {
      const both = raw.match(/^(\s*<\s*)([\s\S]*?)(\s*>\s*)$/);
      if (both) return { prefix: both[1], value: both[2], suffix: both[3] };
    }
    if (/^\s*</.test(raw)) {
      const open = raw.match(/^(\s*<\s*)([\s\S]*)$/);
      return { prefix: open[1], value: open[2], suffix: '' };
    }
    if (/>\s*$/.test(raw)) {
      const close = raw.match(/^([\s\S]*?)(\s*>\s*)$/);
      return { prefix: '', value: close[1], suffix: close[2] };
    }
    return { prefix: '', value: raw, suffix: '' };
  }

  function directionAffixes(raw) {
    const closed = raw.match(/^(\s*\{)([\s\S]*)(\}\s*)$/);
    if (closed) return { prefix: closed[1], value: closed[2], suffix: closed[3] };
    return { prefix: '', value: raw, suffix: '' };
  }

  function contentNote(kind, raw, parts) {
    if (kind === 'lyric') {
      if (parts.prefix.includes('#') || parts.suffix.includes('#')) {
        return 'Green lyric text. The ## marks already on this line stay in place.';
      }
      return 'This line stays in the green lyric section.';
    }
    if (kind === 'singalong') {
      if (parts.prefix.includes('<') || parts.suffix.includes('>')) {
        return 'Pink sing-along text. The < and > marks already on this line stay in place.';
      }
      return 'This line stays in the pink sing-along section.';
    }
    if (kind === 'direction') {
      if (parts.prefix.includes('{')) {
        return 'Shown in italic. The braces stay around this direction.';
      }
      return 'Shown as a stage direction. Edit the whole line, including any braces.';
    }
    if (/^\s*\*[\s\S]*\*\s*$/.test(raw)) {
      return 'Asterisks are not a special format. They stay on this line and show as spoken text.';
    }
    if (/^\s*\([\s\S]*\)\s*$/.test(raw)) {
      return 'This stays as spoken text. Only lines in {braces} show as stage directions.';
    }
    return 'Spoken line.';
  }

  function contentLabel(kind) {
    if (kind === 'lyric') return 'Lyric';
    if (kind === 'singalong') return 'Sing-along';
    if (kind === 'direction') return 'Stage direction';
    return 'Dialogue';
  }

  function makeContent(raw, kind) {
    if (kind === 'lyric' && /^\s*##\s*$/.test(raw)) {
      return line({
        kind,
        label: 'Lyric marker',
        note: 'This line only marks a lyric section with ##. It is read-only so the section is not broken.',
        readOnly: true,
        raw,
        value: raw,
      });
    }
    if (kind === 'singalong' && (/^\s*<\s*$/.test(raw) || /^\s*>\s*$/.test(raw))) {
      return line({
        kind,
        label: 'Sing-along marker',
        note: 'This line only marks a sing-along with < or >. It is read-only so the section is not broken.',
        readOnly: true,
        raw,
        value: raw,
      });
    }

    let parts = { prefix: '', value: raw, suffix: '' };
    if (kind === 'lyric') parts = lyricAffixes(raw);
    else if (kind === 'singalong') parts = singalongAffixes(raw);
    else if (kind === 'direction') parts = directionAffixes(raw);
    parts = faithful(raw, parts.prefix, parts.value, parts.suffix);

    return line({
      kind,
      label: contentLabel(kind),
      note: contentNote(kind, raw, parts),
      raw,
      ...parts,
    });
  }

  function classifyScene(sceneText) {
    const rawLines = sceneText.split('\n');
    const lines = [];
    let titleClaimed = false;
    let inLyric = false;
    let inSingalong = false;

    rawLines.forEach((raw) => {
      if (raw.trim() === '') {
        lines.push(blankLine(raw));
        return;
      }

      let extraHeading = false;
      if (!titleClaimed) {
        titleClaimed = true;
        if (raw.trimEnd().startsWith('#')) {
          lines.push(makeTitle(raw));
          return;
        }
      } else if (raw.trimEnd().startsWith('#') && !/^\s*##/.test(raw)) {
        extraHeading = true;
      }

      if (/^\s*@image:\s*/.test(raw)) {
        const image = makeImage(raw);
        if (extraHeading) image.flags.push('extra-heading');
        lines.push(image);
        return;
      }

      if (SPEAKER_LINE.test(raw)) {
        const speaker = makeSpeaker(raw);
        if (extraHeading) speaker.flags.push('extra-heading');
        lines.push(speaker);
        return;
      }

      const startsLyric = /^\s*##/.test(raw);
      const endsLyric = /##\s*$/.test(raw);
      const startsSingalong = /^\s*</.test(raw);
      const endsSingalong = />[\s]*$/.test(raw);
      if (startsLyric) inLyric = true;
      if (startsSingalong) inSingalong = true;

      let built;
      if (/^\s*\[/.test(raw)) {
        built = makeLocked(raw, 'speaker');
      } else if (/^\s*@/.test(raw)) {
        built = makeLocked(raw, 'directive');
      } else if (inLyric) {
        built = makeContent(raw, 'lyric');
      } else if (inSingalong) {
        built = makeContent(raw, 'singalong');
      } else if (/^\s*\{/.test(raw)) {
        built = makeContent(raw, 'direction');
      } else {
        built = makeContent(raw, 'dialogue');
      }

      if (extraHeading) built.flags.push('extra-heading');
      if (raw.trim() === '---') built.flags.push('weak-separator');
      lines.push(built);

      if (endsLyric) inLyric = false;
      if (endsSingalong) inSingalong = false;
    });

    return {
      lines,
      unclosedLyric: inLyric,
      unclosedSingalong: inSingalong,
    };
  }

  function serializeLine(entry) {
    if (!entry || entry.kind === 'blank' || entry.readOnly) return entry.raw;
    if (entry.kind === 'speaker') {
      const unchanged = entry.names.length === entry.baselineNames.length
        && entry.names.every((name, index) => name === entry.baselineNames[index]);
      if (unchanged) return entry.raw;
      if (entry.names.length === 2) return `[${entry.names[0]}] & [${entry.names[1]}]`;
      return `[${entry.names[0]}]`;
    }
    if (entry.value === entry.baseline) return entry.raw;
    return entry.prefix + entry.value + entry.suffix;
  }

  function serializeScenes(model) {
    return model.scenes
      .map((scene) => scene.lines.map(serializeLine).join('\n'))
      .join(SCENE_SEPARATOR);
  }

  function hasWorkableScene(model) {
    return model.scenes.some((scene) => scene.lines.some((entry) => entry.kind !== 'blank'));
  }

  function load(text) {
    const source = typeof text === 'string' ? text : '';
    const scenes = splitSceneTexts(source).map(classifyScene);
    const model = {
      mode: 'scenes',
      scenes,
      rawText: source,
      fallbackReason: '',
    };
    if (serializeScenes(model) !== source) {
      model.mode = 'raw';
      model.fallbackReason = 'This script could not be opened scene by scene without changing it. Edit the full text below. Nothing has been removed, and the live show is unchanged.';
    } else if (!hasWorkableScene(model)) {
      model.mode = 'raw';
      model.fallbackReason = 'No scenes were found. Edit the full text below. A scene break is a line with only ---. Nothing has been removed, and the live show is unchanged.';
    }
    return model;
  }

  function serialize(model) {
    if (!model) return '';
    if (model.mode === 'raw') return model.rawText;
    return serializeScenes(model);
  }

  function serializeScene(model, sceneIndex) {
    if (!model) return '';
    if (model.mode === 'raw') return model.rawText;
    const scene = model.scenes[sceneIndex];
    if (!scene) return '';
    return scene.lines.map(serializeLine).join('\n');
  }

  function getLine(model, sceneIndex, lineIndex) {
    if (!model || model.mode !== 'scenes') return null;
    const scene = model.scenes[sceneIndex];
    if (!scene || !scene.lines[lineIndex]) return null;
    return scene.lines[lineIndex];
  }

  function setLineText(model, sceneIndex, lineIndex, value) {
    const entry = getLine(model, sceneIndex, lineIndex);
    if (!entry || entry.readOnly || entry.kind === 'blank' || entry.kind === 'speaker') return false;
    entry.value = String(value);
    return true;
  }

  function setSpeakerName(model, sceneIndex, lineIndex, nameIndex, value) {
    const entry = getLine(model, sceneIndex, lineIndex);
    if (!entry || entry.kind !== 'speaker' || entry.readOnly) return false;
    if (!entry.names || nameIndex < 0 || nameIndex >= entry.names.length) return false;
    const next = String(value);
    if (/[\[\]]/.test(next)) return false;
    entry.names[nameIndex] = next;
    entry.value = entry.names.join(' & ');
    return true;
  }

  function sceneImageValue(model, sceneIndex) {
    if (!model || model.mode !== 'scenes') return '';
    const scene = model.scenes[sceneIndex];
    if (!scene) return '';
    const images = scene.lines.filter((entry) => entry.kind === 'image');
    if (!images.length) return '';
    return String(images[images.length - 1].value || '').trim();
  }

  function setSceneImage(model, sceneIndex, reference) {
    if (!model || model.mode !== 'scenes') return false;
    const scene = model.scenes[sceneIndex];
    if (!scene) return false;
    const next = reference == null ? '' : String(reference).trim();
    scene.lines = scene.lines.filter((entry) => entry.kind !== 'image');
    if (!next) return true;
    const image = makeImage(`@image: ${next}`);
    const titleIndex = scene.lines.findIndex((entry) => entry.kind === 'title');
    scene.lines.splice(titleIndex >= 0 ? titleIndex + 1 : 0, 0, image);
    return true;
  }

  function setRawText(model, text) {
    if (!model) return false;
    model.mode = 'raw';
    model.rawText = String(text);
    return true;
  }

  function sceneTitle(scene) {
    if (!scene) return '(Empty scene)';
    const title = scene.lines.find((entry) => entry.kind === 'title');
    if (title) return title.value.trim() || '(Untitled scene)';
    if (scene.lines.some((entry) => entry.kind !== 'blank')) return '(Untitled scene)';
    return '(Empty scene)';
  }

  function sceneLabel(index) {
    return `Scene ${index + 1}`;
  }

  function validate(text) {
    const errors = [];
    const warnings = [];
    if (typeof text !== 'string' || text.trim() === '') {
      errors.push({
        code: 'empty',
        message: 'The script is empty. Add scene text before publishing.',
      });
      return { ok: false, errors, warnings };
    }

    const sceneTexts = splitSceneTexts(text);
    if (!sceneTexts.some((scene) => scene.trim() !== '')) {
      errors.push({
        code: 'no-scenes',
        message: 'No scenes were found. The script is only separators (---), and none of that text was deleted.',
      });
      return { ok: false, errors, warnings };
    }

    sceneTexts.forEach((sceneText, sceneIndex) => {
      const where = sceneLabel(sceneIndex);
      if (sceneText.trim() === '') {
        warnings.push({
          code: 'empty-scene',
          message: `${where} is empty.`,
        });
        return;
      }

      const scene = classifyScene(sceneText);
      if (!scene.lines.some((entry) => entry.kind === 'title')) {
        warnings.push({
          code: 'missing-title',
          message: `${where} does not start with a # title, so the stage will not show a scene heading.`,
        });
      }
      const images = scene.lines.filter((entry) => entry.kind === 'image');
      if (images.length > 1) {
        warnings.push({
          code: 'multiple-images',
          message: `${where} has more than one image line. The stage shows the last one.`,
        });
      }
      if (scene.unclosedLyric) {
        warnings.push({
          code: 'unclosed-lyric',
          message: `${where} has a lyric section that never closes with ##. Later lines in that scene may show as lyrics.`,
        });
      }
      if (scene.unclosedSingalong) {
        warnings.push({
          code: 'unclosed-singalong',
          message: `${where} has a sing-along that never closes with >. Later lines in that scene may show as sing-along.`,
        });
      }

      scene.lines.forEach((entry) => {
        if (entry.flags.includes('extra-heading')) {
          warnings.push({
            code: 'extra-heading',
            message: `${where} has a "#" line that will not start a new scene. Put --- on its own line before it to make a new scene.`,
          });
        }
        if (entry.flags.includes('weak-separator')) {
          warnings.push({
            code: 'weak-separator',
            message: `${where} has a "---" line that is not a scene break. Scene breaks must be three hyphens alone on a line, with no extra spaces.`,
          });
        }
        if (entry.kind === 'image' && entry.value.trim() === '') {
          warnings.push({
            code: 'empty-image',
            message: `${where} has an image line with no file name.`,
          });
        }
        if (entry.kind === 'dialogue' && entry.raw.trim().length > LONG_LINE) {
          warnings.push({
            code: 'long-line',
            message: `${where} has a very long dialogue line (${entry.raw.trim().length} characters). It will still be published.`,
          });
        }
        if (entry.kind === 'speaker' && entry.names.some((name) => name.trim() === '')) {
          errors.push({
            code: 'empty-speaker',
            message: `${where} has a blank character name. Fill it in before publishing.`,
          });
        }
        if (entry.kind === 'locked' && entry.reason === 'speaker') {
          if (/^\s*\[\s*\]/.test(entry.raw) || /&\s*\[\s*\]\s*$/.test(entry.raw)) {
            errors.push({
              code: 'empty-speaker',
              message: `${where} has a blank character name. Fill it in before publishing.`,
            });
          } else {
            const snippet = entry.raw.trim().slice(0, 60);
            warnings.push({
              code: 'malformed-speaker',
              message: `${where} has a character line that is not [NAME] or [NAME] & [NAME]: ${snippet}`,
            });
          }
        }
      });
    });

    return { ok: errors.length === 0, errors, warnings };
  }

  function isDraftScriptId(scriptId) {
    return typeof scriptId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(scriptId);
  }

  // A script id keeps one production's drafts away from another's.
  // Calls without a script id keep the original live-script key.
  function draftKey(revision, scriptId) {
    const suffix = scriptId ? `${scriptId}:${revision || ''}` : String(revision || '');
    return DRAFT_PREFIX + suffix;
  }

  function saveDraft(storage, draft) {
    if (!draft || typeof draft.baseRevision !== 'string' || draft.baseRevision === ''
      || typeof draft.scriptText !== 'string') {
      return { ok: false, error: 'Draft is missing a script id or text.' };
    }
    if (draft.scriptId != null && !isDraftScriptId(draft.scriptId)) {
      return { ok: false, error: 'Draft is missing a script id or text.' };
    }
    const record = {
      baseRevision: draft.baseRevision,
      scriptText: draft.scriptText,
      savedAt: draft.savedAt || new Date().toISOString(),
    };
    if (draft.scriptId) record.scriptId = draft.scriptId;
    try {
      storage.setItem(draftKey(record.baseRevision, draft.scriptId || null), JSON.stringify(record));
      return { ok: true, key: draftKey(record.baseRevision, draft.scriptId || null) };
    } catch (err) {
      return { ok: false, error: 'This browser could not save the draft.' };
    }
  }

  function loadDraft(storage, revision, scriptId) {
    if (!revision) return null;
    if (scriptId != null && !isDraftScriptId(scriptId)) return null;
    let raw;
    try {
      raw = storage.getItem(draftKey(revision, scriptId || null));
    } catch (err) {
      return null;
    }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.baseRevision !== revision || typeof parsed.scriptText !== 'string') {
        return null;
      }
      if (scriptId && parsed.scriptId && parsed.scriptId !== scriptId) return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function listStaleDrafts(storage, revision, scriptId) {
    const stale = [];
    if (scriptId != null && !isDraftScriptId(scriptId)) return stale;
    let length = 0;
    try {
      length = storage.length;
    } catch (err) {
      return stale;
    }
    const namespacedPrefix = scriptId ? `${DRAFT_PREFIX}${scriptId}:` : '';
    for (let index = 0; index < length; index += 1) {
      let key = null;
      try {
        key = storage.key(index);
      } catch (err) {
        continue;
      }
      if (!key || key.indexOf(DRAFT_PREFIX) !== 0) continue;
      let storageRevision;
      if (scriptId) {
        if (key.indexOf(namespacedPrefix) !== 0) continue;
        storageRevision = key.slice(namespacedPrefix.length);
      } else {
        storageRevision = key.slice(DRAFT_PREFIX.length);
        // Namespaced drafts belong to a specific saved script.
        if (storageRevision.indexOf(':') !== -1) continue;
      }
      if (storageRevision === revision) continue;
      let raw = null;
      try {
        raw = storage.getItem(key);
      } catch (err) {
        continue;
      }
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.scriptText !== 'string') continue;
        stale.push({
          storageRevision,
          scriptId: scriptId || '',
          baseRevision: typeof parsed.baseRevision === 'string' ? parsed.baseRevision : storageRevision,
          scriptText: parsed.scriptText,
          savedAt: parsed.savedAt || '',
        });
      } catch (err) {
        // Ignore unreadable draft entries.
      }
    }
    return stale;
  }

  function deleteDraft(storage, revision, scriptId) {
    try {
      storage.removeItem(draftKey(revision, scriptId || null));
      return true;
    } catch (err) {
      return false;
    }
  }

  function deleteStaleDrafts(storage, revision, scriptId) {
    const stale = listStaleDrafts(storage, revision, scriptId);
    stale.forEach((draft) => deleteDraft(storage, draft.storageRevision, scriptId || null));
    return stale.length;
  }

  function createPublishGuard() {
    let pending = false;
    return {
      tryStart() {
        if (pending) return false;
        pending = true;
        return true;
      },
      finish() {
        pending = false;
      },
    };
  }

  function publicationStatus(httpOk, body) {
    if (!httpOk || !body || body.ok !== true) {
      return {
        success: false,
        message: 'The script was not published. The live show is unchanged.',
      };
    }
    const revision = typeof body.revision === 'string' && body.revision !== ''
      ? body.revision
      : null;
    return {
      success: true,
      revision,
      message: body.unchanged
        ? 'The server kept the script that is already live. Connected screens were not given a new script.'
        : 'Published. Connected screens now have this script.',
    };
  }

  function publishConfirmContent(warnings, options) {
    const seen = new Set();
    const warningMessages = [];
    (Array.isArray(warnings) ? warnings : []).forEach((warning) => {
      const message = warning && typeof warning.message === 'string' ? warning.message : '';
      if (!message || seen.has(message)) return;
      seen.add(message);
      warningMessages.push(message);
    });
    const notes = [
      'The Controller keeps the current scene and line numbers when possible, but the words at that position may change.',
      'Actors currently browsing independently will return to the live cue.',
      'The currently published script will be backed up and can be restored if needed.',
    ];
    if (options && options.liveChanged) {
      notes.push('The live script changed after you opened the editor. Publishing replaces that newer script with this one.');
    }
    if (options && options.librarySync) {
      notes.push('The saved library copy of this live script is updated only if that copy has not changed since you opened the editor.');
    }
    return {
      title: 'Publish this script?',
      message: 'This will update the script on all connected Controller, Actor, and Audience screens.',
      notes,
      warnings: warningMessages,
    };
  }

  function publishRequestState(inFlight) {
    if (inFlight) {
      return { label: 'Publishing...', busy: true, allowDismiss: false };
    }
    return { label: 'Publish Now', busy: false, allowDismiss: true };
  }

  function publishOutcome(status) {
    if (!status || status.success !== true) {
      return {
        ok: false,
        closeConfirm: false,
        closeEditor: false,
        clearDraft: false,
        message: status && typeof status.message === 'string' && status.message
          ? status.message
          : 'The script was not published. The live show is unchanged.',
      };
    }
    const revision = typeof status.revision === 'string' && status.revision !== ''
      ? status.revision
      : null;
    return {
      ok: true,
      closeConfirm: true,
      closeEditor: true,
      clearDraft: true,
      revision,
      message: 'Script published successfully.',
    };
  }

  function publishLiveNotice(message, sceneTitle) {
    const base = typeof message === 'string' && message
      ? message
      : 'Script published successfully.';
    const title = typeof sceneTitle === 'string' ? sceneTitle.trim() : '';
    if (!title) return base;
    return `${base} The live cue stayed on “${title}”. This line looks the same when the edit is in another scene.`;
  }

  function confirmCancelFocusId(mode) {
    if (mode === 'restore') return 'editor-restore';
    if (mode === 'discard') return 'editor-close';
    return 'editor-publish';
  }

  function stagePublishedScript(currentText, nextText, previousText) {
    const previous = typeof previousText === 'string' ? previousText : '';
    if (typeof nextText !== 'string' || nextText.trim() === '') {
      return { ok: false, error: 'Empty script' };
    }
    if (currentText === nextText) {
      return { ok: true, text: nextText, previousText: previous, changed: false };
    }
    return {
      ok: true,
      text: nextText,
      previousText: typeof currentText === 'string' ? currentText : previous,
      changed: true,
    };
  }

  return {
    LONG_LINE,
    SCENE_SEPARATOR,
    DRAFT_PREFIX,
    load,
    serialize,
    serializeScene,
    setLineText,
    setSpeakerName,
    sceneImageValue,
    setSceneImage,
    setRawText,
    sceneTitle,
    validate,
    draftKey,
    saveDraft,
    loadDraft,
    listStaleDrafts,
    deleteDraft,
    deleteStaleDrafts,
    createPublishGuard,
    publicationStatus,
    publishConfirmContent,
    publishRequestState,
    publishOutcome,
    publishLiveNotice,
    confirmCancelFocusId,
    stagePublishedScript,
  };
}));
