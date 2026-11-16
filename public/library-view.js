// Script Library dialog.
// Live slides, the cue, the script revision, and the live production id stay
// in PrompterLiveShow. Preview object URLs stay in client.html and are passed
// in at init. A slow GET /api/library can still overwrite a newer socket
// production id; this module does not add a newer-write check.
(function (root, factory) {
  const createLibraryView = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = { createLibraryView };
  } else {
    root.PrompterLibrary = createLibraryView();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createLibraryView(deps) {
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
    const staffStorage = Object.prototype.hasOwnProperty.call(options, 'sessionStorage')
      ? options.sessionStorage
      : defaultSessionStorage();

    let enabled = false;
    let listenersBound = false;
    let openEditor = function () {};
    let isEditorOpen = function () { return false; };
    let showControllerNotice = function () {};
    let revokePreviewUrls = function () {};
    let showResolvedImage = function () {};
    let appendSlidePreview = function () {};

const STAFF_TOKEN_KEY = 'prompter-staff-token';
let libraryEntries = [];
let libraryLiveIdCached = null;
let libraryBusy = false;
let libraryPendingId = null;
let libraryPendingRevision = '';
let libraryPendingReview = false;
let libraryReviewed = null;
let libraryPendingAsset = null;
let libraryImagesScriptId = null;
const libraryGuard = ScriptEditor.createPublishGuard();

function rememberLibraryEntries(scripts, liveId) {
  libraryEntries = Array.isArray(scripts) ? scripts.slice() : [];
  libraryLiveIdCached = liveId || null;
}

function libraryCurrentTitle() {
  const id = liveShow.getLiveScriptId() || libraryLiveIdCached;
  const entry = libraryEntries.find((item) => item.id === id);
  if (entry && entry.title) return entry.title;
  return '';
}

function staffToken() {
  try { return staffStorage.getItem(STAFF_TOKEN_KEY) || ''; }
  catch (err) { return ''; }
}

function setStaffToken(value) {
  try {
    if (value) staffStorage.setItem(STAFF_TOKEN_KEY, value);
    else staffStorage.removeItem(STAFF_TOKEN_KEY);
  } catch (err) {
    // The code can still be sent for this attempt.
  }
}

function libraryFetch(url, options) {
  const headers = new Headers(options && options.headers ? options.headers : undefined);
  const token = staffToken();
  if (token && !headers.has('X-Staff-Token')) headers.set('X-Staff-Token', token);
  return request(url, Object.assign({}, options || {}, { headers }));
}

function libraryDom() {
  return {
    dialog: doc.getElementById('script-library'),
    workspace: doc.getElementById('library-workspace'),
    status: doc.getElementById('library-status'),
    access: doc.getElementById('library-access'),
    token: doc.getElementById('library-token'),
    add: doc.getElementById('library-add'),
    title: doc.getElementById('library-new-title'),
    file: doc.getElementById('library-file'),
    empty: doc.getElementById('library-empty'),
    list: doc.getElementById('library-list'),
    preview: doc.getElementById('library-preview'),
    previewBody: doc.getElementById('library-preview-body'),
    images: doc.getElementById('library-images'),
    imagesTitle: doc.getElementById('library-images-title'),
    imagesList: doc.getElementById('library-images-list'),
    imagesEmpty: doc.getElementById('library-images-empty'),
    imagesStatus: doc.getElementById('library-images-status'),
    imageFile: doc.getElementById('library-image-file'),
    confirm: doc.getElementById('library-confirm'),
    confirmHeading: doc.getElementById('library-confirm-heading'),
    confirmBody: doc.getElementById('library-confirm-body'),
    confirmStatus: doc.getElementById('library-confirm-status'),
    confirmYes: doc.getElementById('library-confirm-yes'),
    confirmNo: doc.getElementById('library-confirm-no'),
  };
}

function setLibraryStatus(message, tone) {
  const status = libraryDom().status;
  status.dataset.tone = tone || 'status';
  status.textContent = message || '';
  status.setAttribute('role', tone === 'alert' ? 'alert' : 'status');
}

function formatModified(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function libraryErrorMessage(response, body, fallback) {
  if (response && response.status === 401) return 'The staff access code was not accepted.';
  if (body && typeof body.error === 'string' && body.error) return body.error;
  return fallback;
}

async function readLibraryJson(response) {
  try { return await response.json(); }
  catch (err) { return null; }
}

function hideLibraryPreview() {
  const ui = libraryDom();
  ui.preview.hidden = true;
  ui.previewBody.replaceChildren();
  ui.add.hidden = false;
  ui.list.hidden = false;
  ui.empty.hidden = libraryEntries.length > 0;
  revokePreviewUrls();
}

function hideLibraryImages() {
  const ui = libraryDom();
  ui.images.hidden = true;
  ui.imagesList.replaceChildren();
  libraryImagesScriptId = null;
  ui.add.hidden = false;
  ui.list.hidden = false;
  ui.empty.hidden = libraryEntries.length > 0;
  revokePreviewUrls();
}

function renderLibraryPreview(script) {
  revokePreviewUrls();
  const ui = libraryDom();
  ui.add.hidden = true;
  ui.list.hidden = true;
  ui.empty.hidden = true;
  ui.images.hidden = true;
  ui.preview.hidden = false;
  ui.previewBody.replaceChildren();
  const heading = doc.createElement('h3');
  heading.textContent = `Preview: ${script.title || 'Untitled script'}`;
  const note = doc.createElement('p');
  note.className = 'library-note';
  note.textContent = 'This preview uses the same reading rules as the stage. It does not move the live cue, and it does not update Actor or Audience screens.';
  ui.previewBody.append(heading, note);
  const slidesForPreview = ScriptFormat.parseScript(script.text || '');
  if (!slidesForPreview.length) {
    const empty = doc.createElement('p');
    empty.textContent = 'Nothing in this script can be previewed yet.';
    ui.previewBody.append(empty);
  } else {
    slidesForPreview.forEach((slide) => { appendSlidePreview(ui.previewBody, slide); });
  }
  ui.previewBody.focus();
}

function renderLibraryList() {
  const ui = libraryDom();
  ui.list.replaceChildren();
  ui.empty.hidden = libraryEntries.length > 0;
  libraryEntries.forEach((entry) => {
    const item = doc.createElement('article');
    item.className = 'library-item';
    const head = doc.createElement('div');
    head.className = 'library-item-head';
    const title = doc.createElement('h3');
    title.className = 'library-title';
    title.textContent = entry.title || 'Untitled script';
    head.append(title);
    const isLive = entry.live || entry.id === liveShow.getLiveScriptId();
    if (isLive) {
      const badge = doc.createElement('p');
      badge.className = 'library-live';
      badge.textContent = 'Live';
      head.append(badge);
    }
    const meta = doc.createElement('p');
    meta.className = 'library-meta';
    const time = doc.createElement('time');
    time.dateTime = entry.updatedAt || '';
    time.textContent = formatModified(entry.updatedAt);
    meta.append('Last modified ', time);
    const actions = doc.createElement('div');
    actions.className = 'library-actions';

    function action(label, name) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'btn';
      button.textContent = label;
      button.setAttribute('aria-label', `${label} ${entry.title || 'saved script'}`);
      button.disabled = libraryBusy;
      button.addEventListener('click', () => name());
      actions.append(button);
      return button;
    }

    action('Preview', () => previewLibraryScript(entry.id));
    action('Edit', () => editLibraryScript(entry));
    action('Manage Images', () => openLibraryImages(entry));
    action('Rename', () => showLibraryRename(item, entry));
    const liveButton = action('Set as Live', () => beginLibrarySetLive(entry));
    if (isLive) {
      liveButton.disabled = true;
      liveButton.textContent = 'Already live';
      liveButton.setAttribute('aria-label', `Already live: ${entry.title || 'saved script'}`);
    }

    const rename = doc.createElement('form');
    rename.hidden = true;
    const renameLabel = doc.createElement('label');
    renameLabel.textContent = 'New title';
    const renameInput = doc.createElement('input');
    renameInput.type = 'text';
    renameInput.value = entry.title || '';
    renameInput.maxLength = 120;
    renameInput.autocomplete = 'off';
    renameLabel.append(doc.createElement('br'), renameInput);
    const renameSave = doc.createElement('button');
    renameSave.type = 'submit';
    renameSave.className = 'btn primary';
    renameSave.textContent = 'Save title';
    const renameCancel = doc.createElement('button');
    renameCancel.type = 'button';
    renameCancel.className = 'btn';
    renameCancel.textContent = 'Cancel';
    renameCancel.addEventListener('click', () => { rename.hidden = true; });
    rename.append(renameLabel, renameSave, renameCancel);
    rename.addEventListener('submit', (event) => {
      event.preventDefault();
      renameLibraryScript(entry, renameInput.value);
    });

    item.append(head, meta, actions, rename);
    item._renameForm = rename;
    ui.list.append(item);
  });
}

function showLibraryRename(item, entry) {
  const form = item._renameForm;
  if (!form) return;
  form.hidden = false;
  const input = form.querySelector('input');
  if (input) {
    input.value = entry.title || '';
    input.focus();
  }
}

async function openLibrary(options) {
  if (!enabled || isEditorOpen()) return;
  const ui = libraryDom();
  if (!ui.dialog.open) ui.dialog.showModal();
  hideLibraryPreview();
  ui.images.hidden = true;
  ui.empty.hidden = true;
  ui.confirm.hidden = true;
  ui.workspace.inert = false;
  const kept = options && options.status ? options.status : '';
  setLibraryStatus(kept || 'Loading saved scripts…', 'status');
  const access = await request('/api/library/access').then((response) => response.json()).catch(() => null);
  if (access && access.required && !staffToken()) {
    ui.access.hidden = false;
    ui.add.hidden = true;
    ui.list.hidden = true;
    ui.empty.hidden = true;
    setLibraryStatus('Enter the staff access code to open the script library.', 'status');
    ui.token.focus();
    return;
  }
  ui.access.hidden = true;
  ui.add.hidden = false;
  await refreshLibrary(kept);
  if (!kept) doc.getElementById('library-close').focus();
}

async function refreshLibrary(keptStatus) {
  const ui = libraryDom();
  ui.dialog.setAttribute('aria-busy', 'true');
  try {
    const response = await libraryFetch('/api/library');
    const body = await readLibraryJson(response);
    if (response.status === 401) {
      setStaffToken('');
      ui.access.hidden = false;
      ui.add.hidden = true;
      setLibraryStatus('The staff access code was not accepted.', 'alert');
      ui.token.focus();
      return;
    }
    if (!response.ok || !body || !Array.isArray(body.scripts)) {
      libraryEntries = [];
      renderLibraryList();
      setLibraryStatus('The script library could not be loaded. The live show was not changed.', 'alert');
      return;
    }
    rememberLibraryEntries(body.scripts, body.liveId);
    // A slow GET /api/library can still overwrite a newer socket production id.
    if (body.liveId) liveShow.setLiveScriptId(body.liveId);
    else if (body.liveId === null) liveShow.setLiveScriptId(null);
    renderLibraryList();
    if (keptStatus) setLibraryStatus(keptStatus, 'status');
    else if (!libraryEntries.length) setLibraryStatus('No saved scripts yet.', 'status');
    else setLibraryStatus('', 'status');
  } catch (err) {
    setLibraryStatus('The script library could not be loaded. The live show was not changed.', 'alert');
  } finally {
    ui.dialog.setAttribute('aria-busy', 'false');
  }
}

async function continueLibraryAccess() {
  const ui = libraryDom();
  setStaffToken(ui.token.value);
  ui.token.value = '';
  await refreshLibrary();
}

async function createLibraryScript(title, text, trackIfCurrent) {
  const checked = ScriptEditor.validate(text);
  if (!checked.ok) {
    setLibraryStatus(checked.errors.map((error) => error.message).join(' '), 'alert');
    return null;
  }
  if (!libraryGuard.tryStart()) return null;
  libraryBusy = true;
  setLibraryStatus('Saving the script…', 'status');
  try {
    const response = await libraryFetch('/api/library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, text, trackIfCurrent: Boolean(trackIfCurrent) }),
    });
    const body = await readLibraryJson(response);
    if (!response.ok || !body || !body.script) {
      setLibraryStatus(libraryErrorMessage(response, body, 'The script was not added. Nothing already saved was replaced.'), 'alert');
      return null;
    }
    await refreshLibrary(`Saved “${body.script.title}” as a new library script. Scripts already in the library were not replaced.`);
    return body.script;
  } catch (err) {
    setLibraryStatus('The script was not added. Nothing already saved was replaced.', 'alert');
    return null;
  } finally {
    libraryBusy = false;
    libraryGuard.finish();
    renderLibraryList();
  }
}

async function saveCurrentLiveScript(event) {
  event.preventDefault();
  const ui = libraryDom();
  const title = ui.title.value;
  if (!title.trim()) {
    setLibraryStatus('Enter a title for this script.', 'alert');
    ui.title.focus();
    return;
  }
  try {
    const response = await request('/script');
    if (!response.ok) throw new Error('load failed');
    const text = await response.text();
    const created = await createLibraryScript(title, text, true);
    if (created) ui.title.value = '';
  } catch (err) {
    setLibraryStatus('The current live script could not be saved. The live show was not changed.', 'alert');
  }
}

async function importLibraryFile() {
  const ui = libraryDom();
  const file = ui.file.files && ui.file.files[0];
  ui.file.value = '';
  if (!file) return;
  if (!ui.title.value.trim()) {
    setLibraryStatus('Enter a title, then choose the text file again.', 'alert');
    ui.title.focus();
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    setLibraryStatus('That file is too large. The library accepts a plain-text script up to 5 MB.', 'alert');
    return;
  }
  let text = '';
  try {
    text = await file.text();
  } catch (err) {
    setLibraryStatus('That file could not be read. The live show was not changed.', 'alert');
    return;
  }
  const created = await createLibraryScript(ui.title.value, text, false);
  if (created) ui.title.value = '';
}

async function previewLibraryScript(id) {
  if (!libraryGuard.tryStart()) return;
  setLibraryStatus('Loading preview…', 'status');
  try {
    const response = await libraryFetch(`/api/library/${id}`);
    const body = await readLibraryJson(response);
    if (!response.ok || !body || !body.script) {
      setLibraryStatus(libraryErrorMessage(response, body, 'The preview could not be opened. The live show was not changed.'), 'alert');
      return;
    }
    libraryReviewed = {
      id: body.script.id,
      revision: body.script.revision || '',
    };
    renderLibraryPreview(body.script);
    setLibraryStatus('Preview only. The live show was not changed.', 'status');
  } catch (err) {
    setLibraryStatus('The preview could not be opened. The live show was not changed.', 'alert');
  } finally {
    libraryGuard.finish();
  }
}

function editLibraryScript(entry) {
  const ui = libraryDom();
  if (ui.dialog.open) ui.dialog.close();
  openEditor({
    id: entry.id,
    title: entry.title,
    revision: entry.revision,
  });
}

async function renameLibraryScript(entry, title) {
  if (!libraryGuard.tryStart()) return;
  try {
    const response = await libraryFetch(`/api/library/${entry.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, expectedRevision: entry.revision }),
    });
    const body = await readLibraryJson(response);
    if (!response.ok || !body || !body.script) {
      setLibraryStatus(libraryErrorMessage(response, body, 'The title was not changed.'), 'alert');
      return;
    }
    await refreshLibrary(`Renamed the saved script to “${body.script.title}”. The live show was not changed.`);
  } catch (err) {
    setLibraryStatus('The title was not changed. The live show was not changed.', 'alert');
  } finally {
    libraryGuard.finish();
  }
}

function beginLibrarySetLive(entry) {
  if (entry.live || entry.id === liveShow.getLiveScriptId()) return;
  if (!libraryGuard.tryStart()) return;
  libraryGuard.finish();
  libraryPendingId = entry.id;
  libraryPendingRevision = ScriptLibrary.reviewedLiveRevision(entry, libraryReviewed);
  libraryPendingReview = false;
  const ui = libraryDom();
  const content = ScriptLibrary.liveSwitchConfirmContent(libraryCurrentTitle(), entry.title);
  ui.confirmBody.replaceChildren();
  ui.confirmStatus.textContent = '';
  ui.confirmStatus.classList.remove('editor-error');
  ui.confirmHeading.textContent = content.title;
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
  ui.confirmBody.append(message, notes);
  ui.confirmYes.textContent = ScriptLibrary.setLiveRequestState(false).label;
  ui.confirmYes.disabled = false;
  ui.confirmNo.disabled = false;
  ui.workspace.inert = true;
  ui.confirm.hidden = false;
  ui.confirmYes.focus();
}

function hideLibraryConfirm() {
  const ui = libraryDom();
  libraryPendingId = null;
  libraryPendingRevision = '';
  libraryPendingReview = false;
  libraryPendingAsset = null;
  ui.confirm.hidden = true;
  ui.confirmStatus.textContent = '';
  ui.confirmStatus.classList.remove('editor-error');
  ui.workspace.inert = false;
}

function beginRemoveLibraryImage(asset) {
  if (!libraryGuard.tryStart()) return;
  libraryGuard.finish();
  libraryPendingAsset = asset;
  libraryPendingId = null;
  libraryPendingRevision = '';
  libraryPendingReview = false;
  const ui = libraryDom();
  ui.confirmBody.replaceChildren();
  ui.confirmStatus.textContent = '';
  ui.confirmStatus.classList.remove('editor-error');
  ui.confirmHeading.textContent = 'Remove this image?';
  const message = doc.createElement('p');
  message.className = 'editor-confirm-message';
  message.textContent = `Remove “${asset.name || 'this image'}” from this production. The live show does not change.`;
  ui.confirmBody.append(message);
  ui.confirmYes.textContent = 'Remove image';
  ui.confirmYes.disabled = false;
  ui.confirmNo.disabled = false;
  ui.workspace.inert = true;
  ui.confirm.hidden = false;
  ui.confirmYes.focus();
}

async function runRemoveLibraryImage() {
  if (!libraryPendingAsset || !libraryImagesScriptId || !libraryGuard.tryStart()) return;
  const asset = libraryPendingAsset;
  const ui = libraryDom();
  ui.confirmYes.disabled = true;
  ui.confirmNo.disabled = true;
  ui.confirm.setAttribute('aria-busy', 'true');
  ui.confirmYes.textContent = 'Removing…';
  try {
    const response = await libraryFetch(`/api/library/${libraryImagesScriptId}/assets/${asset.id}`, {
      method: 'DELETE',
    });
    const body = await readLibraryJson(response);
    if (!response.ok) {
      ui.confirmStatus.classList.add('editor-error');
      ui.confirmStatus.textContent = libraryErrorMessage(response, body, 'That image was not removed.');
      ui.confirmYes.disabled = false;
      ui.confirmNo.disabled = false;
      ui.confirmYes.textContent = 'Remove image';
      ui.confirmYes.focus();
      return;
    }
    hideLibraryConfirm();
    setImageStatus(`Removed “${asset.name || 'the image'}”. The live show was not changed.`, 'status');
    await refreshLibraryImages();
  } catch (err) {
    ui.confirmStatus.classList.add('editor-error');
    ui.confirmStatus.textContent = 'That image was not removed.';
    ui.confirmYes.disabled = false;
    ui.confirmNo.disabled = false;
    ui.confirmYes.textContent = 'Remove image';
  } finally {
    libraryGuard.finish();
    ui.confirm.setAttribute('aria-busy', 'false');
  }
}

function setImageStatus(message, tone) {
  const status = libraryDom().imagesStatus;
  status.dataset.tone = tone || 'status';
  status.textContent = message || '';
}

async function refreshLibraryImages() {
  const ui = libraryDom();
  const scriptId = libraryImagesScriptId;
  if (!scriptId) return;
  revokePreviewUrls();
  ui.imagesList.replaceChildren();
  let response;
  let body;
  try {
    response = await libraryFetch(`/api/library/${scriptId}/assets`);
    body = await readLibraryJson(response);
  } catch (err) {
    setImageStatus('The images could not be loaded.', 'alert');
    return;
  }
  if (libraryImagesScriptId !== scriptId) return;
  if (!response.ok || !body || !Array.isArray(body.assets)) {
    setImageStatus(libraryErrorMessage(response, body, 'The images could not be loaded.'), 'alert');
    return;
  }
  if (ui.imagesStatus.textContent === 'Loading images…') setImageStatus('', 'status');
  ui.imagesEmpty.hidden = body.assets.length > 0;
  body.assets.forEach((asset) => {
    const card = doc.createElement('article');
    card.className = 'library-image-card';
    const frame = doc.createElement('div');
    const name = doc.createElement('p');
    name.className = 'library-title';
    name.textContent = asset.name || 'Saved image';
    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'btn';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${asset.name || 'image'}`);
    remove.addEventListener('click', () => beginRemoveLibraryImage(asset));
    card.append(frame, name, remove);
    ui.imagesList.append(card);
    showResolvedImage(frame, ScriptLibrary.imageReference(scriptId, asset.id));
  });
}

async function openLibraryImages(entry) {
  const ui = libraryDom();
  hideLibraryPreview();
  libraryImagesScriptId = entry.id;
  ui.add.hidden = true;
  ui.list.hidden = true;
  ui.empty.hidden = true;
  ui.images.hidden = false;
  ui.imagesTitle.textContent = `Images for ${entry.title || 'this production'}`;
  setImageStatus('Loading images…', 'status');
  await refreshLibraryImages();
  ui.imageFile.focus();
}

async function uploadLibraryImage() {
  const ui = libraryDom();
  const file = ui.imageFile.files && ui.imageFile.files[0];
  ui.imageFile.value = '';
  if (!file || !libraryImagesScriptId) return;
  if (!libraryGuard.tryStart()) return;
  setImageStatus('Uploading image…', 'status');
  try {
    const response = await libraryFetch(`/api/library/${libraryImagesScriptId}/assets`, {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Asset-Name': encodeURIComponent(file.name || 'Image'),
      },
      body: file,
    });
    const body = await readLibraryJson(response);
    if (!response.ok || !body || !body.asset) {
      setImageStatus(libraryErrorMessage(response, body, 'That image was not uploaded.'), 'alert');
      return;
    }
    setImageStatus(`Uploaded “${body.asset.name}”. The live show was not changed.`, 'status');
    await refreshLibraryImages();
  } catch (err) {
    setImageStatus('That image was not uploaded. The live show was not changed.', 'alert');
  } finally {
    libraryGuard.finish();
  }
}

async function runLibrarySetLive() {
  if (!libraryPendingId || !libraryGuard.tryStart()) return;
  const ui = libraryDom();
  const id = libraryPendingId;
  ui.confirmYes.disabled = true;
  ui.confirmNo.disabled = true;
  ui.confirm.setAttribute('aria-busy', 'true');
  ui.confirmYes.textContent = ScriptLibrary.setLiveRequestState(true).label;
  ui.confirmStatus.textContent = ui.confirmYes.textContent;
  try {
    const response = await libraryFetch(`/api/library/${id}/live`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: libraryPendingRevision }),
    });
    const body = await readLibraryJson(response);
    const outcome = ScriptLibrary.setLiveOutcome(response.ok, body);
    if (!outcome.ok) {
      ui.confirmStatus.classList.add('editor-error');
      ui.confirmStatus.textContent = outcome.message;
      ui.confirmYes.disabled = false;
      ui.confirmNo.disabled = false;
      if (outcome.review) {
        libraryPendingReview = true;
        ui.confirmYes.textContent = 'Review latest';
      } else {
        ui.confirmYes.textContent = ScriptLibrary.setLiveRequestState(false).label;
      }
      ui.confirmYes.focus();
      return;
    }
    hideLibraryConfirm();
    showControllerNotice(outcome.message);
    await refreshLibrary(outcome.message);
  } catch (err) {
    ui.confirmStatus.classList.add('editor-error');
    ui.confirmStatus.textContent = 'The live script was not changed.';
    ui.confirmYes.disabled = false;
    ui.confirmNo.disabled = false;
    ui.confirmYes.textContent = ScriptLibrary.setLiveRequestState(false).label;
  } finally {
    libraryGuard.finish();
    ui.confirm.setAttribute('aria-busy', 'false');
  }
}

async function reviewLatestBeforeSetLive() {
  const id = libraryPendingId;
  hideLibraryConfirm();
  await refreshLibrary('');
  if (id) await previewLibraryScript(id);
  if (libraryReviewed && libraryReviewed.id === id) {
    setLibraryStatus('This saved script changed. Review the latest version below before setting it live.', 'status');
  }
}

function closeLibrary() {
  const ui = libraryDom();
  if (!ui.confirm.hidden) {
    if (ui.confirm.getAttribute('aria-busy') === 'true') return;
    hideLibraryConfirm();
    return;
  }
  hideLibraryPreview();
  hideLibraryImages();
  if (ui.dialog.open) ui.dialog.close();
  doc.getElementById('btn-script-library').focus();
}

function bindLibrary() {
  const ui = libraryDom();
  doc.getElementById('btn-script-library').addEventListener('click', () => openLibrary());
  doc.getElementById('library-close').addEventListener('click', closeLibrary);
  doc.getElementById('library-token-continue').addEventListener('click', continueLibraryAccess);
  ui.add.addEventListener('submit', saveCurrentLiveScript);
  ui.file.addEventListener('change', importLibraryFile);
  doc.getElementById('library-preview-back').addEventListener('click', () => {
    hideLibraryPreview();
    setLibraryStatus('', 'status');
    doc.getElementById('library-close').focus();
  });
  doc.getElementById('library-images-back').addEventListener('click', () => {
    hideLibraryImages();
    setLibraryStatus('', 'status');
    doc.getElementById('library-close').focus();
  });
  ui.imageFile.addEventListener('change', uploadLibraryImage);
  ui.confirmNo.addEventListener('click', () => {
    if (ui.confirm.getAttribute('aria-busy') === 'true') return;
    hideLibraryConfirm();
  });
  ui.confirmYes.addEventListener('click', () => {
    if (libraryPendingAsset) runRemoveLibraryImage();
    else if (libraryPendingReview) reviewLatestBeforeSetLive();
    else runLibrarySetLive();
  });
  ui.confirm.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (ui.confirm.getAttribute('aria-busy') !== 'true') hideLibraryConfirm();
    }
  });
  ui.dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeLibrary();
  });
}

    function isOpen() {
      if (!doc || !doc.getElementById) return false;
      const dialog = doc.getElementById('script-library');
      return Boolean(dialog && dialog.open);
    }

    function isEnabled() {
      return enabled;
    }

    function getEntries() {
      return libraryEntries;
    }

    function init(settings) {
      const config = settings || {};
      enabled = true;
      if (config.openEditor) openEditor = config.openEditor;
      if (config.editorIsOpen) isEditorOpen = config.editorIsOpen;
      if (config.showControllerNotice) showControllerNotice = config.showControllerNotice;
      if (config.revokePreviewUrls) revokePreviewUrls = config.revokePreviewUrls;
      if (config.showResolvedImage) showResolvedImage = config.showResolvedImage;
      if (config.appendSlidePreview) appendSlidePreview = config.appendSlidePreview;
      if (listenersBound) return;
      listenersBound = true;
      bindLibrary();
    }

    return {
      init,
      open: openLibrary,
      isOpen,
      isEnabled,
      fetch: libraryFetch,
      remember: rememberLibraryEntries,
      getEntries,
      currentTitle: libraryCurrentTitle,
      readJson: readLibraryJson,
      errorMessage: libraryErrorMessage,
    };
  }

  function defaultSessionStorage() {
    try {
      return typeof globalThis !== 'undefined' ? globalThis.sessionStorage : null;
    } catch (err) {
      return null;
    }
  }

  return createLibraryView;
}));
