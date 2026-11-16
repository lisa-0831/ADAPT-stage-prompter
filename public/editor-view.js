(function (root, factory) {
  const createEditorView = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = { createEditorView };
  } else {
    root.PrompterEditor = createEditorView();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createEditorView(deps) {
    const options = deps || {};
    const doc = options.document
      || (typeof globalThis !== 'undefined' ? globalThis.document : null);
    const request = options.fetch
      || (typeof globalThis !== 'undefined' ? globalThis.fetch : null);
    const liveShow = options.liveShow
      || (typeof globalThis !== 'undefined' ? globalThis.PrompterLiveShow : null);
    const ScriptEditor = options.ScriptEditor
      || (typeof globalThis !== 'undefined' ? globalThis.ScriptEditor : null);
    const ScriptLibrary = options.ScriptLibrary
      || (typeof globalThis !== 'undefined' ? globalThis.ScriptLibrary : null);
    const ScriptFormat = options.ScriptFormat
      || (typeof globalThis !== 'undefined' ? globalThis.ScriptFormat : null);
    const crypto = options.crypto
      || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    const viewWindow = options.window
      || (typeof globalThis !== 'undefined' ? globalThis.window : null);
    const localStorage = options.storage
      || (typeof globalThis !== 'undefined' ? globalThis.localStorage : null);

    let libraryFetch;
    let rememberLibraryEntries;
    let openLibrary;
    let readLibraryJson;
    let libraryErrorMessage;
    let libraryCurrentTitle;
    let revokePreviewUrls;
    let showResolvedImage;
    let appendSlidePreview;
    let getLibraryEntries;
    let enabled = false;

    let editorMode = 'live';
    let editorLibraryId = null;
    let editorAssetCatalog = [];
    let editorLibraryRevision = null;
    let editorLibraryTitle = '';
    let returnToLibrary = false;
    let libraryNoticeAfterClose = '';
    let editorModel = null;
    let editorSceneIndex = 0;
    let editorBaseRevision = null;
    let editorBaselineText = '';
    let editorOpenToken = 0;
    let editorPreviewOn = false;
    let editorConfirmMode = null;
    let editorConfirmYesLabel = 'Publish Now';
    let editorPreviousText = '';
    let editorAwaitingRevision = false;
    let controllerNoticeTimer = 0;
    const editorPublishGuard = ScriptEditor.createPublishGuard();
    let editorDom = null;

    function isEnabled() {
      return enabled;
    }

function isOpen() {
  return Boolean(editorDom && editorDom.dialog && editorDom.dialog.open);
}

function captureEditorDom() {
  editorDom = {
  dialog: doc.getElementById('script-editor'),
  workspace: doc.getElementById('editor-workspace'),
  notice: doc.getElementById('controller-notice'),
  status: doc.getElementById('editor-status'),
  dirty: doc.getElementById('editor-dirty'),
  conflict: doc.getElementById('editor-conflict'),
  stale: doc.getElementById('editor-stale'),
  staleText: doc.getElementById('editor-stale-text'),
  discardStale: doc.getElementById('editor-discard-stale'),
  sceneRow: doc.getElementById('editor-scene-row'),
  scene: doc.getElementById('editor-scene'),
  lines: doc.getElementById('editor-lines'),
  rawWrap: doc.getElementById('editor-raw-wrap'),
  fallback: doc.getElementById('editor-fallback'),
  raw: doc.getElementById('editor-raw'),
  validation: doc.getElementById('editor-validation'),
  preview: doc.getElementById('editor-preview'),
  previewBtn: doc.getElementById('editor-preview-btn'),
  confirm: doc.getElementById('editor-confirm'),
  confirmHeading: doc.getElementById('editor-confirm-heading'),
  confirmBody: doc.getElementById('editor-confirm-body'),
  confirmStatus: doc.getElementById('editor-confirm-status'),
  confirmYes: doc.getElementById('editor-confirm-yes'),
  confirmNo: doc.getElementById('editor-confirm-no'),
  save: doc.getElementById('editor-save'),
  saveLibrary: doc.getElementById('editor-save-library'),
  setLive: doc.getElementById('editor-set-live'),
  publish: doc.getElementById('editor-publish'),
  restore: doc.getElementById('editor-restore'),
  closeTop: doc.getElementById('editor-close-top'),
  close: doc.getElementById('editor-close'),
};
}

function editorDraftScriptId() {
  if (editorLibraryId) return editorLibraryId;
  return 'live';
}

function noteScriptRevision() {
  if (!isOpen()) return;
  syncEditorConflict();
}

function draftStorage() {
  try {
    const probe = '__prompter_draft_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch (err) {
    return null;
  }
}

async function scriptHash(text) {
  if (!crypto.subtle) return null;
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function editorIsDirty() {
  if (!editorModel) return false;
  return ScriptEditor.serialize(editorModel) !== editorBaselineText;
}

function sceneOptionLabel(scene, index) {
  const title = ScriptEditor.sceneTitle(scene).replace(/\s+/g, ' ').trim();
  const short = title.length > 80 ? `${title.slice(0, 77)}...` : title;
  return `${index + 1}. ${short}`;
}

function syncEditorConflict() {
  const changed = editorMode !== 'library'
    && isOpen()
    && editorBaseRevision
    && liveShow.getRevision()
    && editorBaseRevision !== liveShow.getRevision()
    && !editorAwaitingRevision;
  editorDom.conflict.hidden = !changed;
  if (changed) {
    editorDom.conflict.textContent = 'The live script changed while this editor was open. Your edits are still based on the earlier script. Publishing will replace whatever is live now.';
  }
}

function showIssues(result, announce) {
  const box = editorDom.validation;
  box.replaceChildren();
  if (!result.errors.length && !result.warnings.length) {
    box.setAttribute('role', 'status');
    return;
  }
  const list = doc.createElement('ul');
  result.errors.forEach((error) => {
    const item = doc.createElement('li');
    item.className = 'editor-error';
    item.textContent = `Error: ${error.message}`;
    list.append(item);
  });
  result.warnings.forEach((warning) => {
    const item = doc.createElement('li');
    item.className = 'editor-warning';
    item.textContent = `Note: ${warning.message}`;
    list.append(item);
  });
  box.append(list);
  box.setAttribute('role', announce ? 'alert' : 'status');
  if (announce) box.focus();
}

function updateDirty(result) {
  if (!editorModel) {
    editorDom.dirty.textContent = '';
    return;
  }
  const parts = [];
  if (editorIsDirty()) {
    parts.push('Unsaved changes. The live show is not using these edits.');
  } else {
    const storage = draftStorage();
    const draft = storage && editorBaseRevision
      ? ScriptEditor.loadDraft(storage, editorBaseRevision)
      : null;
    parts.push(draft && draft.scriptText === editorBaselineText
      ? 'No unsaved changes. A draft is saved in this browser.'
      : 'No unsaved changes.');
  }
  if (result.errors.length) {
    const noun = result.errors.length === 1 ? 'error' : 'errors';
    parts.push(`${result.errors.length} ${noun}. Publishing stays off until they are fixed.`);
  } else if (result.warnings.length) {
    const noun = result.warnings.length === 1 ? 'note' : 'notes';
    parts.push(`${result.warnings.length} ${noun}. You can still publish.`);
  }
  editorDom.dirty.textContent = parts.join(' ');
}

function refreshEditorChrome() {
  if (!editorModel) return;
  const result = ScriptEditor.validate(ScriptEditor.serialize(editorModel));
  showIssues(result, false);
  updateDirty(result);
  const libraryEditing = editorMode === 'library';
  editorDom.saveLibrary.hidden = !libraryEditing;
  editorDom.setLive.hidden = !libraryEditing;
  editorDom.publish.hidden = libraryEditing;
  if (libraryEditing) editorDom.restore.hidden = true;
  editorDom.publish.disabled = libraryEditing || !(editorBaseRevision && result.ok && !editorAwaitingRevision);
  editorDom.save.disabled = !editorBaseRevision || editorAwaitingRevision;
  editorDom.saveLibrary.disabled = !libraryEditing || !editorLibraryId || editorAwaitingRevision;
  editorDom.setLive.disabled = !libraryEditing || !editorLibraryId || editorIsDirty() || editorAwaitingRevision;
  syncEditorConflict();
}

function fillSceneSelect() {
  editorDom.scene.replaceChildren();
  editorModel.scenes.forEach((scene, index) => {
    const option = doc.createElement('option');
    option.value = String(index);
    option.textContent = sceneOptionLabel(scene, index);
    editorDom.scene.append(option);
  });
  const maxIndex = Math.max(0, editorModel.scenes.length - 1);
  editorSceneIndex = Math.min(editorSceneIndex, maxIndex);
  editorDom.scene.value = String(editorSceneIndex);
}

function updateSceneOption(sceneIndex) {
  const option = editorDom.scene.options[sceneIndex];
  if (!option || !editorModel) return;
  option.textContent = sceneOptionLabel(editorModel.scenes[sceneIndex], sceneIndex);
}

function bindEditorControl(control, sceneIndex, lineIndex, entry, nameIndex) {
  control.addEventListener('input', () => {
    const fieldError = control.nextElementSibling;
    if (entry.kind === 'speaker') {
      const ok = ScriptEditor.setSpeakerName(
        editorModel,
        sceneIndex,
        lineIndex,
        nameIndex,
        control.value,
      );
      if (fieldError) {
        fieldError.textContent = ok ? '' : 'Character names cannot include [ or ].';
      }
      if (!ok) {
        control.value = editorModel.scenes[sceneIndex].lines[lineIndex].names[nameIndex];
      }
    } else {
      ScriptEditor.setLineText(editorModel, sceneIndex, lineIndex, control.value);
      if (entry.kind === 'title') updateSceneOption(sceneIndex);
    }
    if (editorPreviewOn) renderEditorPreview();
    refreshEditorChrome();
  });
}

function renderEditorLine(entry, sceneIndex, lineIndex, visible) {
  const labelText = `Line ${visible}: ${entry.label}`;
  if (entry.kind === 'speaker' && entry.names.length > 1) {
    const fieldset = doc.createElement('fieldset');
    fieldset.className = 'editor-field';
    const legend = doc.createElement('legend');
    legend.textContent = labelText;
    fieldset.append(legend);
    entry.names.forEach((name, nameIndex) => {
      const label = doc.createElement('label');
      const id = `editor-line-${sceneIndex}-${lineIndex}-name-${nameIndex}`;
      label.htmlFor = id;
      label.textContent = nameIndex === 0 ? 'First character' : 'Second character';
      const input = doc.createElement('input');
      input.type = 'text';
      input.id = id;
      input.value = name;
      input.autocomplete = 'off';
      input.autocapitalize = 'off';
      input.spellcheck = false;
      const error = doc.createElement('p');
      error.className = 'editor-field-error';
      error.setAttribute('role', 'status');
      fieldset.append(label, input, error);
      bindEditorControl(input, sceneIndex, lineIndex, entry, nameIndex);
    });
    const note = doc.createElement('p');
    note.className = 'editor-note';
    note.textContent = entry.note;
    fieldset.append(note);
    return fieldset;
  }

  const wrap = doc.createElement('div');
  wrap.className = 'editor-field';
  const id = `editor-line-${sceneIndex}-${lineIndex}`;
  const noteId = `${id}-note`;
  const label = doc.createElement('label');
  label.htmlFor = id;
  label.textContent = labelText;
  const multiline = entry.kind !== 'title' && entry.kind !== 'image' && entry.kind !== 'speaker';
  const control = doc.createElement(multiline ? 'textarea' : 'input');
  if (!multiline) control.type = 'text';
  control.id = id;
  control.value = entry.kind === 'speaker' ? entry.names[0] : entry.value;
  control.autocomplete = 'off';
  control.autocapitalize = 'off';
  control.spellcheck = entry.kind !== 'image' && entry.kind !== 'speaker';
  control.setAttribute('aria-describedby', noteId);
  if (multiline) {
    control.rows = entry.value.length > 180 ? 4 : 2;
  }
  if (entry.readOnly) control.readOnly = true;
  const error = doc.createElement('p');
  error.className = 'editor-field-error';
  error.setAttribute('role', 'status');
  const note = doc.createElement('p');
  note.className = 'editor-note';
  note.id = noteId;
  note.textContent = entry.note;
  wrap.append(label, control, error, note);
  if (!entry.readOnly) bindEditorControl(control, sceneIndex, lineIndex, entry, 0);
  return wrap;
}

function renderEditorLines() {
  editorDom.lines.replaceChildren();
  const scene = editorModel && editorModel.scenes[editorSceneIndex];
  if (!scene) return;
  if (editorLibraryId) renderSceneImageControl();
  let visible = 0;
  scene.lines.forEach((entry, lineIndex) => {
    if (entry.kind === 'blank') return;
    if (editorLibraryId && entry.kind === 'image') return;
    visible += 1;
    editorDom.lines.append(renderEditorLine(entry, editorSceneIndex, lineIndex, visible));
  });
}

function renderSceneImageControl() {
  const reference = ScriptEditor.sceneImageValue(editorModel, editorSceneIndex);
  const wrap = doc.createElement('div');
  wrap.className = 'editor-field';
  const label = doc.createElement('p');
  label.id = 'editor-scene-image-label';
  label.textContent = reference
    ? `Scene image: ${ScriptLibrary.imageLabel(reference, editorAssetCatalog)}`
    : 'Scene image: none';
  const row = doc.createElement('div');
  row.className = 'library-actions';
  const choose = doc.createElement('button');
  choose.type = 'button';
  choose.className = 'btn';
  choose.textContent = 'Choose image';
  choose.addEventListener('click', () => openSceneImageChooser(wrap));
  const remove = doc.createElement('button');
  remove.type = 'button';
  remove.className = 'btn';
  remove.textContent = 'Remove image';
  remove.disabled = !reference;
  remove.addEventListener('click', () => applySceneImage(''));
  row.append(choose, remove);
  const note = doc.createElement('p');
  note.className = 'editor-note';
  note.textContent = 'Choose a picture uploaded for this production. Saving to the library does not change the live show.';
  const preview = doc.createElement('div');
  preview.id = 'editor-scene-image-preview';
  wrap.append(label, row, note, preview);
  editorDom.lines.append(wrap);
  if (reference) showResolvedImage(preview, reference);
  rememberSceneImageNames(label, reference);
}

function rememberSceneImageNames(label, reference) {
  if (!editorLibraryId || !reference) return;
  if (editorAssetCatalog.some((asset) => asset.scriptId === editorLibraryId)) return;
  const scriptId = editorLibraryId;
  libraryFetch(`/api/library/${scriptId}/assets`).then(async (response) => {
    const body = await readLibraryJson(response);
    if (!response.ok || !body || !Array.isArray(body.assets)) return;
    if (editorLibraryId !== scriptId || !label.isConnected) return;
    editorAssetCatalog = body.assets.map((asset) => ({
      id: asset.id,
      scriptId,
      name: asset.name,
    }));
    label.textContent = `Scene image: ${ScriptLibrary.imageLabel(reference, editorAssetCatalog)}`;
  }).catch(() => {});
}

function applySceneImage(reference) {
  ScriptEditor.setSceneImage(editorModel, editorSceneIndex, reference);
  if (editorPreviewOn) renderEditorPreview();
  renderEditor();
  refreshEditorChrome();
}

async function openSceneImageChooser(wrap) {
  let chooser = wrap.querySelector('.editor-image-chooser');
  if (chooser) {
    chooser.remove();
    return;
  }
  chooser = doc.createElement('div');
  chooser.className = 'editor-image-chooser';
  chooser.setAttribute('role', 'group');
  chooser.setAttribute('aria-label', 'Images for this production');
  const status = doc.createElement('p');
  status.className = 'editor-note';
  status.textContent = 'Loading images…';
  chooser.append(status);
  wrap.append(chooser);
  try {
    const response = await libraryFetch(`/api/library/${editorLibraryId}/assets`);
    const body = await readLibraryJson(response);
    if (!chooser.isConnected) return;
    chooser.replaceChildren();
    if (!response.ok || !body || !Array.isArray(body.assets)) {
      status.textContent = libraryErrorMessage(response, body, 'The images for this production could not be loaded.');
      chooser.append(status);
      return;
    }
    editorAssetCatalog = body.assets.map((asset) => ({
      id: asset.id,
      scriptId: editorLibraryId,
      name: asset.name,
    }));
    const currentLabel = doc.getElementById('editor-scene-image-label');
    const currentReference = ScriptEditor.sceneImageValue(editorModel, editorSceneIndex);
    if (currentLabel && currentReference) {
      currentLabel.textContent = `Scene image: ${ScriptLibrary.imageLabel(currentReference, editorAssetCatalog)}`;
    }
    if (!body.assets.length) {
      status.textContent = 'No images yet. Use Manage Images in the Script Library to upload one.';
      chooser.append(status);
      return;
    }
    body.assets.forEach((asset) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'btn';
      button.textContent = asset.name || 'Saved image';
      button.addEventListener('click', () => {
        applySceneImage(ScriptLibrary.imageReference(editorLibraryId, asset.id));
      });
      chooser.append(button);
    });
  } catch (err) {
    if (!chooser.isConnected) return;
    status.textContent = 'The images for this production could not be loaded.';
  }
}

function renderEditor() {
  if (!editorModel) return;
  const raw = editorModel.mode === 'raw';
  editorDom.sceneRow.hidden = raw;
  editorDom.lines.hidden = raw;
  editorDom.rawWrap.hidden = !raw;
  editorDom.fallback.hidden = !(raw && editorModel.fallbackReason);
  editorDom.fallback.textContent = raw ? editorModel.fallbackReason : '';
  if (raw) editorDom.raw.value = editorModel.rawText;
  else {
    fillSceneSelect();
    renderEditorLines();
  }
  refreshEditorChrome();
}

async function renderEditorPreview() {
  revokePreviewUrls();
  editorDom.preview.replaceChildren();
  const heading = doc.createElement('h3');
  heading.textContent = 'Structured preview';
  const note = doc.createElement('p');
  note.className = 'editor-note';
  note.textContent = 'This uses the same reading rules as the stage. It does not move the live cue, and it does not update Actor or Audience screens. It shows the saved words, not the AA/Aa display setting.';
  editorDom.preview.append(heading, note);
  if (!editorModel) return;
  const text = editorModel.mode === 'raw'
    ? ScriptEditor.serialize(editorModel)
    : ScriptEditor.serializeScene(editorModel, editorSceneIndex);
  const slides = ScriptFormat.parseScript(text);
  if (!slides.length) {
    const empty = doc.createElement('p');
    empty.textContent = 'Nothing in this scene can be previewed yet.';
    editorDom.preview.append(empty);
    return;
  }
  const pending = [];
  slides.forEach((slide) => { pending.push(appendSlidePreview(editorDom.preview, slide)); });
  await Promise.all(pending);
}

function relevantStaleDrafts(storage) {
  const named = ScriptEditor.listStaleDrafts(storage, editorBaseRevision, editorDraftScriptId());
  if (editorMode === 'library') return named;
  return named.concat(ScriptEditor.listStaleDrafts(storage, editorBaseRevision));
}

function showStaleDrafts() {
  const storage = draftStorage();
  if (!storage || !editorBaseRevision) {
    editorDom.stale.hidden = true;
    return;
  }
  const stale = relevantStaleDrafts(storage);
  if (!stale.length) {
    editorDom.stale.hidden = true;
    return;
  }
  const noun = stale.length === 1 ? 'draft' : 'drafts';
  const verb = stale.length === 1 ? 'It was' : 'They were';
  const pronoun = stale.length === 1 ? 'it' : 'they';
  editorDom.stale.hidden = false;
  editorDom.staleText.textContent = `This browser has ${stale.length} saved ${noun} for an older script. ${verb} not opened, so ${pronoun} cannot replace the current script.`;
}

async function refreshRestoreButton() {
  try {
    const res = await request('/script/previous');
    if (!res.ok) {
      editorPreviousText = '';
      editorDom.restore.hidden = true;
      return;
    }
    editorPreviousText = await res.text();
    editorDom.restore.hidden = false;
  } catch (err) {
    editorDom.restore.hidden = true;
  }
}

function focusEditorStart() {
  if (!editorModel || editorModel.mode === 'raw') {
    if (editorModel) editorDom.raw.focus();
    else editorDom.close.focus();
    return;
  }
  editorDom.scene.focus();
}

function appendParagraphs(parent, sentences) {
  sentences.forEach((sentence) => {
    const paragraph = doc.createElement('p');
    paragraph.textContent = sentence;
    parent.append(paragraph);
  });
}

function discardMessage() {
  const storage = draftStorage();
  const draft = storage && editorBaseRevision
    ? ScriptEditor.loadDraft(storage, editorBaseRevision)
    : null;
  if (draft) {
    return 'These edits are not saved. If you close, the draft you last saved in this browser stays, and the newer edits are lost. The live show is unchanged.';
  }
  return 'These edits are not saved. If you close, they will be lost. The live show is unchanged.';
}

function showControllerNotice(message) {
  viewWindow.clearTimeout(controllerNoticeTimer);
  editorDom.notice.hidden = false;
  editorDom.notice.textContent = message;
  controllerNoticeTimer = viewWindow.setTimeout(() => {
    editorDom.notice.hidden = true;
    editorDom.notice.textContent = '';
  }, 12000);
}

function showEditorConfirm(mode, warnings) {
  editorConfirmMode = mode;
  editorDom.confirmBody.replaceChildren();
  editorDom.confirmStatus.textContent = '';
  editorDom.confirmStatus.classList.remove('editor-error');
  editorDom.confirmStatus.tabIndex = -1;
  editorDom.confirmYes.classList.remove('primary', 'danger');
  editorDom.confirmYes.disabled = false;
  editorDom.confirmNo.disabled = false;
  editorDom.confirm.setAttribute('aria-busy', 'false');
  if (mode === 'publish') {
    const content = ScriptEditor.publishConfirmContent(warnings, {
      liveChanged: Boolean(
        editorBaseRevision && liveShow.getRevision() && editorBaseRevision !== liveShow.getRevision(),
      ),
      librarySync: Boolean(editorLibraryId),
    });
    editorDom.confirmHeading.textContent = content.title;
    editorConfirmYesLabel = ScriptEditor.publishRequestState(false).label;
    editorDom.confirmYes.classList.add('primary');
    const message = doc.createElement('p');
    message.className = 'editor-confirm-message';
    message.textContent = content.message;
    const notesTitle = doc.createElement('h4');
    notesTitle.textContent = 'Important';
    const notes = doc.createElement('ul');
    notes.className = 'editor-confirm-notes';
    content.notes.forEach((note) => {
      const item = doc.createElement('li');
      item.textContent = note;
      notes.append(item);
    });
    editorDom.confirmBody.append(message, notesTitle, notes);
    if (content.warnings.length) {
      const box = doc.createElement('div');
      box.className = 'editor-confirm-warnings';
      const title = doc.createElement('h4');
      title.textContent = 'Warnings';
      const list = doc.createElement('ul');
      content.warnings.forEach((warning) => {
        const item = doc.createElement('li');
        item.textContent = warning;
        list.append(item);
      });
      box.append(title, list);
      editorDom.confirmBody.append(box);
    }
  } else if (mode === 'restore') {
    editorDom.confirmHeading.textContent = 'Restore the previous script?';
    editorConfirmYesLabel = 'Restore now';
    editorDom.confirmYes.classList.add('danger');
    appendParagraphs(editorDom.confirmBody, [
      'This puts the last published script back on every connected screen. The script that is live now is saved, so you can switch back.',
      'The Controller keeps the same scene and line numbers when they still exist. Actors return to the live cue.',
    ]);
    const restoreNotes = ScriptEditor.publishConfirmContent(warnings).warnings;
    if (restoreNotes.length) {
      const box = doc.createElement('div');
      box.className = 'editor-confirm-warnings';
      const title = doc.createElement('h4');
      title.textContent = 'Warnings';
      const list = doc.createElement('ul');
      restoreNotes.forEach((warning) => {
        const item = doc.createElement('li');
        item.textContent = warning;
        list.append(item);
      });
      box.append(title, list);
      editorDom.confirmBody.append(box);
    }
  } else if (mode === 'set-live') {
    const content = ScriptLibrary.liveSwitchConfirmContent(
      libraryCurrentTitle(),
      editorLibraryTitle,
    );
    editorDom.confirmHeading.textContent = content.title;
    editorConfirmYesLabel = ScriptLibrary.setLiveRequestState(false).label;
    editorDom.confirmYes.classList.add('primary');
    const message = doc.createElement('p');
    message.className = 'editor-confirm-message';
    message.textContent = content.message;
    const notes = doc.createElement('ul');
    notes.className = 'editor-confirm-notes';
    content.notes.forEach((note) => {
      const item = doc.createElement('li');
      item.textContent = note;
      notes.append(item);
    });
    editorDom.confirmBody.append(message, notes);
    appendParagraphs(editorDom.confirmBody, [
      'This uses the copy saved in the library. Save to Library first if this screen still has newer edits.',
    ]);
  } else {
    editorDom.confirmHeading.textContent = 'Discard unsaved edits?';
    editorConfirmYesLabel = 'Discard unsaved edits';
    editorDom.confirmYes.classList.add('danger');
    appendParagraphs(editorDom.confirmBody, [discardMessage()]);
  }
  editorDom.confirmYes.textContent = editorConfirmYesLabel;
  editorDom.workspace.inert = true;
  editorDom.confirm.hidden = false;
  editorDom.confirmYes.focus();
}

function hideEditorConfirm() {
  editorConfirmMode = null;
  editorDom.confirm.hidden = true;
  editorDom.confirm.setAttribute('aria-busy', 'false');
  editorDom.confirmStatus.textContent = '';
  editorDom.confirmStatus.classList.remove('editor-error');
  editorDom.confirmYes.disabled = false;
  editorDom.confirmNo.disabled = false;
  editorDom.workspace.inert = false;
}

function cancelEditorConfirm() {
  if (editorAwaitingRevision) return;
  const mode = editorConfirmMode;
  hideEditorConfirm();
  const target = doc.getElementById(ScriptEditor.confirmCancelFocusId(mode));
  if (target) target.focus();
}

function setConfirmBusy(busy) {
  const publishing = busy && editorConfirmMode === 'publish';
  const settingLive = busy && editorConfirmMode === 'set-live';
  const state = publishing
    ? ScriptEditor.publishRequestState(true)
    : ScriptLibrary.setLiveRequestState(settingLive);
  editorAwaitingRevision = busy;
  editorDom.confirm.setAttribute('aria-busy', busy ? 'true' : 'false');
  editorDom.confirmYes.disabled = busy;
  editorDom.confirmNo.disabled = busy;
  editorDom.publish.disabled = busy || editorDom.publish.disabled;
  editorDom.restore.disabled = busy || editorDom.restore.disabled;
  editorDom.saveLibrary.disabled = busy || editorDom.saveLibrary.disabled;
  editorDom.setLive.disabled = busy || editorDom.setLive.disabled;
  if (!busy) return;
  if (publishing) editorDom.confirmYes.textContent = state.label;
  else if (settingLive) editorDom.confirmYes.textContent = state.label;
  else editorDom.confirmYes.textContent = 'Restoring...';
  editorDom.confirmStatus.classList.remove('editor-error');
  editorDom.confirmStatus.textContent = editorDom.confirmYes.textContent;
  editorDom.confirmStatus.tabIndex = 0;
  editorDom.confirmStatus.focus();
}

function showConfirmFailure(message) {
  editorDom.confirmStatus.classList.add('editor-error');
  editorDom.confirmStatus.tabIndex = -1;
  editorDom.confirmStatus.textContent = message;
  editorDom.confirmYes.disabled = false;
  editorDom.confirmNo.disabled = false;
  editorDom.confirmYes.textContent = editorConfirmYesLabel;
  editorDom.confirmYes.focus();
}

function onConfirmKeydown(event) {
  if (!editorConfirmMode) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (!editorAwaitingRevision) cancelEditorConfirm();
    return;
  }
  if (event.key !== 'Tab') return;
  const items = [...editorDom.confirm.querySelectorAll('button:not([disabled]), #editor-confirm-status[tabindex="0"]')];
  if (!items.length) {
    event.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && doc.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && doc.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function forceCloseEditor() {
  const reopenLibrary = returnToLibrary;
  const libraryStatus = libraryNoticeAfterClose;
  returnToLibrary = false;
  libraryNoticeAfterClose = '';
  editorOpenToken += 1;
  editorMode = 'live';
  hideEditorConfirm();
  editorPreviewOn = false;
  editorDom.preview.hidden = true;
  editorDom.previewBtn.setAttribute('aria-expanded', 'false');
  editorDom.previewBtn.textContent = 'Preview';
  editorDom.saveLibrary.hidden = true;
  editorDom.setLive.hidden = true;
  editorDom.publish.hidden = false;
  const title = doc.getElementById('script-editor-title');
  if (title) title.textContent = 'Edit Script';
  if (editorDom.dialog.open) editorDom.dialog.close();
  if (reopenLibrary) openLibrary({ status: libraryStatus });
}

function requestCloseEditor() {
  if (editorAwaitingRevision) return;
  if (editorConfirmMode) {
    cancelEditorConfirm();
    return;
  }
  if (editorIsDirty()) {
    showEditorConfirm('discard');
    return;
  }
  forceCloseEditor();
}

async function open(libraryScript) {
  const fromLibrary = Boolean(libraryScript && typeof libraryScript.id === 'string');
  if (fromLibrary) returnToLibrary = true;
  if (editorDom.dialog.open) return;
  if (!fromLibrary) returnToLibrary = false;
  const token = ++editorOpenToken;
  editorMode = fromLibrary ? 'library' : 'live';
  editorLibraryId = fromLibrary ? libraryScript.id : null;
  editorLibraryRevision = fromLibrary ? libraryScript.revision : null;
  editorLibraryTitle = fromLibrary ? libraryScript.title || '' : '';
  editorConfirmMode = null;
  editorPreviewOn = false;
  editorDom.preview.hidden = true;
  editorDom.confirm.hidden = true;
  editorDom.workspace.inert = false;
  editorDom.lines.replaceChildren();
  editorDom.validation.replaceChildren();
  doc.getElementById('script-editor-title').textContent = fromLibrary
    ? 'Edit saved script'
    : 'Edit Script';
  doc.getElementById('script-editor-help').textContent = fromLibrary
    ? 'You are editing a saved library script. Save to Library keeps it in the library and does not change the live show. Set as Live is a separate step and uses the saved copy.'
    : 'Choose a scene and edit the lines. Save a draft to keep the work in this browser. The live show does not change until you publish. Replace Script is different: it pastes a whole script and goes live immediately.';
  editorDom.status.textContent = fromLibrary
    ? 'Loading the saved script…'
    : 'Loading the current script…';
  editorDom.dirty.textContent = '';
  editorDom.dialog.showModal();
  try {
    let published = '';
    if (fromLibrary) {
      const res = await libraryFetch(`/api/library/${libraryScript.id}`);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !body.script || typeof body.script.text !== 'string') {
        throw new Error('Could not load the saved script');
      }
      published = body.script.text;
      editorLibraryTitle = body.script.title || editorLibraryTitle;
      editorLibraryRevision = body.script.revision || editorLibraryRevision;
    } else {
      const res = await request('/script');
      if (!res.ok) throw new Error('Could not load the script');
      published = await res.text();
      try {
        const listed = await libraryFetch('/api/library');
        if (listed.ok) {
          const body = await listed.json();
          if (body && Array.isArray(body.scripts)) {
            rememberLibraryEntries(body.scripts, body.liveId);
            if (body.liveId) liveShow.setLiveScriptId(body.liveId);
          }
        }
      } catch (err) {
        editorLibraryId = null;
      }
    }
    if (token !== editorOpenToken || !editorDom.dialog.open) return;
    const hash = await scriptHash(published);
    if (token !== editorOpenToken || !editorDom.dialog.open) return;
    editorBaseRevision = hash || (fromLibrary ? editorLibraryRevision : liveShow.getRevision());
    if (!fromLibrary) {
      const linked = getLibraryEntries().find((item) => item.id === liveShow.getLiveScriptId());
      editorLibraryId = null;
      editorLibraryRevision = null;
      if (linked && hash && linked.revision === hash) {
        editorLibraryId = linked.id;
        editorLibraryRevision = linked.revision;
        editorLibraryTitle = linked.title || '';
      }
    }
    const storage = draftStorage();
    let draft = null;
    if (storage && editorBaseRevision) {
      draft = ScriptEditor.loadDraft(storage, editorBaseRevision, editorDraftScriptId());
      if (!draft && !fromLibrary) draft = ScriptEditor.loadDraft(storage, editorBaseRevision);
    }
    const source = draft ? draft.scriptText : published;
    editorBaselineText = source;
    editorModel = ScriptEditor.load(source);
    editorSceneIndex = 0;
    renderEditor();
    showStaleDrafts();
    if (fromLibrary) editorDom.restore.hidden = true;
    else await refreshRestoreButton();
    if (token !== editorOpenToken || !editorDom.dialog.open) return;
    if (!editorBaseRevision) {
      editorDom.status.textContent = 'The script is still connecting. Close this and open it again before saving.';
    } else if (draft) {
      editorDom.status.textContent = fromLibrary
        ? 'Opened your saved draft for this library script. The live show has not changed.'
        : 'Opened your saved draft for this script. Drafts stay in this browser only. The live show has not changed.';
    } else if (fromLibrary) {
      editorDom.status.textContent = 'You are editing the saved script. The live show does not change until you set a script live.';
    } else {
      editorDom.status.textContent = 'You are editing a copy of the live script. The show does not change until you publish. Drafts stay in this browser only.';
    }
    syncEditorConflict();
    focusEditorStart();
  } catch (err) {
    if (token !== editorOpenToken || !editorDom.dialog.open) return;
    editorModel = null;
    editorDom.publish.disabled = true;
    editorDom.save.disabled = true;
    editorDom.saveLibrary.disabled = true;
    editorDom.setLive.disabled = true;
    editorDom.status.textContent = fromLibrary
      ? 'The saved script could not be loaded. The live show was not changed.'
      : 'The script could not be loaded. The live show was not changed.';
  }
}

function saveEditorDraft() {
  if (!editorModel || !editorBaseRevision) {
    editorDom.status.textContent = 'The script is still connecting, so a draft cannot be saved yet.';
    return;
  }
  const storage = draftStorage();
  if (!storage) {
    editorDom.status.textContent = 'This browser could not save the draft. Your edits stay on this screen until you publish.';
    return;
  }
  const text = ScriptEditor.serialize(editorModel);
  const saved = ScriptEditor.saveDraft(storage, {
    baseRevision: editorBaseRevision,
    scriptId: editorDraftScriptId(),
    scriptText: text,
    savedAt: new Date().toISOString(),
  });
  if (!saved.ok) {
    editorDom.status.textContent = saved.error;
    return;
  }
  editorBaselineText = text;
  editorDom.status.textContent = 'Draft saved in this browser. The live show was not changed.';
  refreshEditorChrome();
}

function beginPublish() {
  if (!editorModel) return;
  const text = ScriptEditor.serialize(editorModel);
  const result = ScriptEditor.validate(text);
  if (!result.ok) {
    showIssues(result, true);
    return;
  }
  showEditorConfirm('publish', result.warnings);
}

async function beginRestore() {
  try {
    const res = await request('/script/previous');
    if (!res.ok) {
      editorDom.restore.hidden = true;
      editorDom.status.textContent = 'There is no previous script to restore. The live show was not changed.';
      return;
    }
    editorPreviousText = await res.text();
    const result = ScriptEditor.validate(editorPreviousText);
    if (!result.ok) {
      showIssues(result, true);
      editorDom.status.textContent = 'The previous script cannot be restored because it is not valid. The live show was not changed.';
      return;
    }
    showEditorConfirm('restore', result.warnings);
  } catch (err) {
    editorDom.status.textContent = 'The previous script could not be loaded. The live show was not changed.';
  }
}

async function runPublish(text) {
  if (!editorPublishGuard.tryStart()) return;
  const mode = editorConfirmMode;
  editorAwaitingRevision = true;
  editorDom.confirmYes.disabled = true;
  editorDom.confirmNo.disabled = true;
  try {
    const result = ScriptEditor.validate(text);
    if (!result.ok) {
      const message = result.errors.map((error) => error.message).join(' ')
        || 'The script was not published. The live show is unchanged.';
      showConfirmFailure(message);
      return;
    }
    setConfirmBusy(true);
    const headers = { 'Content-Type': 'text/plain' };
    if (mode === 'restore') {
      headers['X-Restore-Previous'] = '1';
    } else if (editorMode !== 'library' && editorLibraryId && editorLibraryRevision) {
      headers['X-Library-Id'] = editorLibraryId;
      headers['X-Library-Revision'] = editorLibraryRevision;
    }
    const res = await request('/script', {
      method: 'POST',
      headers,
      body: text,
    });
    let body = null;
    try { body = await res.json(); } catch (err) { body = null; }
    const status = ScriptEditor.publicationStatus(res.ok, body);
    if (mode === 'publish') {
      const outcome = ScriptEditor.publishOutcome(status);
      if (!outcome.ok) {
        showConfirmFailure(outcome.message);
        return;
      }
      const storage = draftStorage();
      if (outcome.clearDraft && storage && editorBaseRevision) {
        ScriptEditor.deleteDraft(storage, editorBaseRevision, editorDraftScriptId());
        ScriptEditor.deleteDraft(storage, editorBaseRevision);
      }
      if (outcome.revision) editorBaseRevision = outcome.revision;
      editorBaselineText = text;
      forceCloseEditor();
      const liveState = liveShow.getLiveState();
      const slides = liveShow.getSlides();
      const liveSlide = liveState && slides[liveState.slideIndex];
      let notice = ScriptEditor.publishLiveNotice(
        outcome.message,
        liveSlide && liveSlide.title,
      );
      if (body && body.libraryConflict) {
        notice += ' The saved library copy was not changed, because it was updated after you opened the editor.';
      }
      showControllerNotice(notice);
      doc.getElementById('btn-edit-script').focus();
      return;
    }
    if (!status.success) {
      showConfirmFailure(status.message);
      return;
    }
    const storage = draftStorage();
    const previousBase = editorBaseRevision;
    if (storage && previousBase) {
      ScriptEditor.deleteDraft(storage, previousBase, editorDraftScriptId());
      ScriptEditor.deleteDraft(storage, previousBase);
    }
    editorBaseRevision = status.revision;
    editorBaselineText = text;
    if (!editorModel || ScriptEditor.serialize(editorModel) !== text) {
      editorModel = ScriptEditor.load(text);
      editorSceneIndex = 0;
      renderEditor();
    }
    hideEditorConfirm();
    editorDom.status.textContent = status.message;
    await refreshRestoreButton();
  } catch (err) {
    showConfirmFailure('The script was not published. The live show is unchanged.');
  } finally {
    editorAwaitingRevision = false;
    editorPublishGuard.finish();
    editorDom.confirm.setAttribute('aria-busy', 'false');
    if (editorConfirmMode) {
      editorDom.confirmYes.disabled = false;
      editorDom.confirmNo.disabled = false;
      editorDom.confirmYes.textContent = editorConfirmYesLabel;
    }
    editorDom.restore.disabled = false;
    refreshEditorChrome();
  }
}

async function saveLibraryScript() {
  if (editorMode !== 'library' || !editorModel || !editorLibraryId || !editorLibraryRevision) {
    editorDom.status.textContent = 'This saved script cannot be updated yet. The live show was not changed.';
    return;
  }
  if (!editorPublishGuard.tryStart()) return;
  const text = ScriptEditor.serialize(editorModel);
  const result = ScriptEditor.validate(text);
  if (!result.ok) {
    showIssues(result, true);
    editorPublishGuard.finish();
    return;
  }
  editorDom.saveLibrary.disabled = true;
  try {
    const res = await libraryFetch(`/api/library/${editorLibraryId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, expectedRevision: editorLibraryRevision }),
    });
    const body = await res.json().catch(() => null);
    if (res.status === 409 || (body && body.code === 'conflict')) {
      editorDom.status.textContent = body && body.error
        ? body.error
        : 'This saved script was changed after you opened it. Your edits were not saved over that newer copy.';
      return;
    }
    if (!res.ok || !body || !body.script) {
      editorDom.status.textContent = 'The saved script was not updated. The live show was not changed.';
      return;
    }
    const storage = draftStorage();
    if (storage) ScriptEditor.deleteDraft(storage, editorBaseRevision, editorLibraryId);
    editorLibraryRevision = body.script.revision;
    editorBaseRevision = body.script.revision;
    editorBaselineText = text;
    editorLibraryTitle = body.script.title || editorLibraryTitle;
    editorDom.status.textContent = 'Saved to the library. The live show was not changed.';
    refreshEditorChrome();
  } catch (err) {
    editorDom.status.textContent = 'The saved script was not updated. The live show was not changed.';
  } finally {
    editorPublishGuard.finish();
    refreshEditorChrome();
  }
}

function beginSetLiveFromEditor() {
  if (editorMode !== 'library' || !editorLibraryId) return;
  if (editorIsDirty()) {
    editorDom.status.textContent = 'Save to the library before setting this script live. The live show was not changed.';
    return;
  }
  if (!editorLibraryRevision) {
    editorDom.status.textContent = 'The script revision was missing, so this script was not set live. Close the editor and open the saved script again.';
    return;
  }
  showEditorConfirm('set-live');
}

async function runEditorSetLive() {
  if (!editorLibraryId || !editorPublishGuard.tryStart()) return;
  editorAwaitingRevision = true;
  editorDom.confirmYes.disabled = true;
  editorDom.confirmNo.disabled = true;
  try {
    setConfirmBusy(true);
    const res = await libraryFetch(`/api/library/${editorLibraryId}/live`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: editorLibraryRevision }),
    });
    const body = await res.json().catch(() => null);
    const outcome = ScriptLibrary.setLiveOutcome(res.ok, body);
    if (!outcome.ok) {
      if (outcome.review) {
        editorConfirmMode = 'reload-saved';
        editorConfirmYesLabel = 'Load latest version';
      }
      showConfirmFailure(outcome.message);
      return;
    }
    libraryNoticeAfterClose = outcome.message;
    forceCloseEditor();
    showControllerNotice(outcome.message);
  } catch (err) {
    showConfirmFailure('The live script was not changed.');
  } finally {
    editorAwaitingRevision = false;
    editorPublishGuard.finish();
    editorDom.confirm.setAttribute('aria-busy', 'false');
    if (editorConfirmMode) {
      editorDom.confirmYes.disabled = false;
      editorDom.confirmNo.disabled = false;
      editorDom.confirmYes.textContent = editorConfirmYesLabel;
    }
    refreshEditorChrome();
  }
}

async function loadLatestSavedScript() {
  if (!editorLibraryId) return;
  if (editorIsDirty()) {
    showConfirmFailure('Save or discard the open edits before loading the latest saved script. The live show was not changed.');
    return;
  }
  if (!editorPublishGuard.tryStart()) return;
  editorDom.confirmYes.disabled = true;
  editorDom.confirmNo.disabled = true;
  try {
    const res = await libraryFetch(`/api/library/${editorLibraryId}`);
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !body.script || typeof body.script.text !== 'string') {
      showConfirmFailure('The latest saved script could not be loaded. The live show was not changed.');
      return;
    }
    const script = body.script;
    editorLibraryRevision = script.revision || null;
    editorLibraryTitle = script.title || editorLibraryTitle;
    editorBaseRevision = script.revision || editorBaseRevision;
    editorBaselineText = script.text;
    editorModel = ScriptEditor.load(script.text);
    editorSceneIndex = 0;
    renderEditor();
    showStaleDrafts();
    hideEditorConfirm();
    editorDom.status.textContent = 'Loaded the latest saved script. The live show was not changed. Review it, then set it live.';
  } catch (err) {
    showConfirmFailure('The latest saved script could not be loaded. The live show was not changed.');
  } finally {
    editorPublishGuard.finish();
    editorDom.confirmYes.disabled = false;
    editorDom.confirmNo.disabled = false;
    refreshEditorChrome();
  }
}

function init(settings) {
  const given = settings || {};
  libraryFetch = given.libraryFetch;
  rememberLibraryEntries = given.rememberLibraryEntries;
  openLibrary = given.openLibrary;
  readLibraryJson = given.readLibraryJson;
  libraryErrorMessage = given.libraryErrorMessage;
  libraryCurrentTitle = given.libraryCurrentTitle;
  revokePreviewUrls = given.revokePreviewUrls;
  showResolvedImage = given.showResolvedImage;
  appendSlidePreview = given.appendSlidePreview;
  getLibraryEntries = given.getLibraryEntries;
  enabled = true;
  captureEditorDom();
  doc.getElementById('btn-edit-script').addEventListener('click', () => open());
  editorDom.closeTop.addEventListener('click', requestCloseEditor);
  editorDom.close.addEventListener('click', requestCloseEditor);
  editorDom.save.addEventListener('click', saveEditorDraft);
  editorDom.saveLibrary.addEventListener('click', saveLibraryScript);
  editorDom.setLive.addEventListener('click', beginSetLiveFromEditor);
  editorDom.publish.addEventListener('click', beginPublish);
  editorDom.restore.addEventListener('click', beginRestore);
  editorDom.confirmNo.addEventListener('click', cancelEditorConfirm);
  editorDom.confirm.addEventListener('click', (event) => {
    if (event.target !== editorDom.confirm || editorAwaitingRevision) return;
    cancelEditorConfirm();
  });
  editorDom.confirm.addEventListener('keydown', onConfirmKeydown);
  editorDom.confirmYes.addEventListener('click', () => {
    if (editorAwaitingRevision || !editorPublishGuard) return;
    const mode = editorConfirmMode;
    if (mode === 'discard') {
      forceCloseEditor();
      return;
    }
    if (mode === 'publish') runPublish(ScriptEditor.serialize(editorModel));
    if (mode === 'restore') runPublish(editorPreviousText);
    if (mode === 'set-live') runEditorSetLive();
    if (mode === 'reload-saved') loadLatestSavedScript();
  });
  editorDom.previewBtn.addEventListener('click', () => {
    editorPreviewOn = !editorPreviewOn;
    editorDom.preview.hidden = !editorPreviewOn;
    editorDom.previewBtn.setAttribute('aria-expanded', editorPreviewOn ? 'true' : 'false');
    editorDom.previewBtn.textContent = editorPreviewOn ? 'Hide preview' : 'Preview';
    if (editorPreviewOn) {
      renderEditorPreview();
      editorDom.preview.focus();
    }
  });
  editorDom.scene.addEventListener('change', () => {
    editorSceneIndex = Number(editorDom.scene.value);
    renderEditorLines();
    if (editorPreviewOn) renderEditorPreview();
    refreshEditorChrome();
  });
  editorDom.raw.addEventListener('input', () => {
    if (!editorModel) return;
    ScriptEditor.setRawText(editorModel, editorDom.raw.value);
    if (editorPreviewOn) renderEditorPreview();
    refreshEditorChrome();
  });
  editorDom.discardStale.addEventListener('click', () => {
    const storage = draftStorage();
    if (storage && editorBaseRevision) {
      ScriptEditor.deleteStaleDrafts(storage, editorBaseRevision, editorDraftScriptId());
      if (editorMode !== 'library') ScriptEditor.deleteStaleDrafts(storage, editorBaseRevision);
    }
    editorDom.stale.hidden = true;
    editorDom.status.textContent = 'Old drafts were deleted. The current script was not changed.';
  });
  editorDom.dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (editorAwaitingRevision) return;
    requestCloseEditor();
  });
}


    function showNotice(message) {
      showControllerNotice(message);
    }

    return {
      init,
      open,
      isOpen,
      isEnabled,
      noteScriptRevision,
      showNotice,
    };
  }

  return createEditorView;
}));
