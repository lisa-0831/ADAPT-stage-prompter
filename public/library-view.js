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
    const objectUrls = Object.prototype.hasOwnProperty.call(options, 'objectUrls')
      ? options.objectUrls
      : (typeof globalThis !== 'undefined' ? globalThis.URL : null);
    const cryptoApi = Object.prototype.hasOwnProperty.call(options, 'crypto')
      ? options.crypto
      : (typeof globalThis !== 'undefined' ? globalThis.crypto : null);

    let enabled = false;
    let listenersBound = false;
    let openEditor = function () {};
    let isEditorOpen = function () { return false; };
    let showControllerNotice = function () {};
    let noteSavedHead = function () {};
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
let libraryPendingDelete = null;
let libraryDeleteTrigger = null;
let libraryDeleteBusy = false;
let libraryImagesScriptId = null;
const libraryGuard = ScriptEditor.createPublishGuard();
let createSession = null;
let createScriptToken = 0;
let createSceneKey = 0;
let filePickerOpen = false;
let filePickerRelease = null;
let libraryHighlightId = null;
let manageAsset = null;
let historyProductionId = null;
let historyTitle = '';
let historyListing = null;
let historyDetail = null;
let historyRestoreId = null;
let historyRestoreSource = null;
let historyBusy = false;
let historyCheckToken = 0;
const historyObjectUrls = [];

function manageFileSignature(file) {
  return [
    file && file.name || '',
    file && file.size || 0,
    file && file.lastModified || 0,
    file && file.type || '',
  ].join('\0');
}

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
    createOpen: doc.getElementById('library-create-open'),
    create: doc.getElementById('library-create'),
    createTitle: doc.getElementById('library-create-name'),
    createScript: doc.getElementById('library-create-script'),
    createScriptPicked: doc.getElementById('library-create-script-picked'),
    createScriptName: doc.getElementById('library-create-script-name'),
    createScriptClear: doc.getElementById('library-create-script-clear'),
    createCard: doc.getElementById('library-create-card'),
    createCardPicked: doc.getElementById('library-create-card-picked'),
    createCardPreview: doc.getElementById('library-create-card-preview'),
    createCardName: doc.getElementById('library-create-card-name'),
    createCardClear: doc.getElementById('library-create-card-clear'),
    createScenes: doc.getElementById('library-create-scenes'),
    createSceneList: doc.getElementById('library-create-scene-list'),
    createReview: doc.getElementById('library-create-review'),
    createStatus: doc.getElementById('library-create-status'),
    createSubmit: doc.getElementById('library-create-submit'),
    createRetry: doc.getElementById('library-create-retry'),
    createEdit: doc.getElementById('library-create-edit'),
    createCancel: doc.getElementById('library-create-cancel'),
    empty: doc.getElementById('library-empty'),
    list: doc.getElementById('library-list'),
    preview: doc.getElementById('library-preview'),
    previewBody: doc.getElementById('library-preview-body'),
    images: doc.getElementById('library-images'),
    imagesTitle: doc.getElementById('library-images-title'),
    imagesList: doc.getElementById('library-images-list'),
    imagesEmpty: doc.getElementById('library-images-empty'),
    imagesStatus: doc.getElementById('library-images-status'),
    history: doc.getElementById('library-history'),
    historyTitle: doc.getElementById('library-history-title'),
    historyStatus: doc.getElementById('library-history-status'),
    historyWarning: doc.getElementById('library-history-warning'),
    historyList: doc.getElementById('library-history-list'),
    historyPreview: doc.getElementById('library-history-preview'),
    historyPreviewTitle: doc.getElementById('library-history-preview-title'),
    historyPreviewMeta: doc.getElementById('library-history-preview-meta'),
    historyPreviewImages: doc.getElementById('library-history-preview-images'),
    historyPreviewText: doc.getElementById('library-history-preview-text'),
    historyRestore: doc.getElementById('library-history-restore'),
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
  const specific = ScriptLibrary && typeof ScriptLibrary.operationFailureMessage === 'function'
    ? ScriptLibrary.operationFailureMessage(body)
    : null;
  if (specific) return specific;
  if (body && typeof body.error === 'string' && body.error) return body.error;
  return fallback;
}

function newRequestId() {
  if (!ScriptLibrary || typeof ScriptLibrary.requestIdentity !== 'function') return null;
  return ScriptLibrary.requestIdentity(cryptoApi);
}

async function readLibraryJson(response) {
  try { return await response.json(); }
  catch (err) { return null; }
}

function hideAddForm(ui, hidden) {
  if (ui && ui.add) ui.add.hidden = hidden;
}

function revealLibraryHome() {
  const ui = libraryDom();
  if (createSession) {
    ui.create.hidden = false;
    ui.createOpen.hidden = true;
    hideAddForm(ui, true);
    ui.list.hidden = true;
    ui.empty.hidden = true;
    return;
  }
  ui.create.hidden = true;
  ui.createOpen.hidden = false;
  hideAddForm(ui, false);
  ui.list.hidden = false;
  ui.empty.hidden = libraryEntries.length > 0;
}

function hideLibraryPreview() {
  const ui = libraryDom();
  ui.preview.hidden = true;
  ui.previewBody.replaceChildren();
  revokePreviewUrls();
  revealLibraryHome();
}

function hideLibraryImages() {
  const ui = libraryDom();
  ui.images.hidden = true;
  ui.imagesList.replaceChildren();
  libraryImagesScriptId = null;
  manageAsset = null;
  revokePreviewUrls();
  revealLibraryHome();
}

function renderLibraryPreview(script) {
  revokePreviewUrls();
  const ui = libraryDom();
  hideAddForm(ui, true);
  ui.list.hidden = true;
  ui.empty.hidden = true;
  ui.images.hidden = true;
  ui.create.hidden = true;
  ui.createOpen.hidden = true;
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
    const headIsLive = savedHeadIsLive(entry, isLive);
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
    let createdNote = null;
    if (entry.id === libraryHighlightId && !isLive) {
      createdNote = doc.createElement('p');
      createdNote.className = 'library-note';
      createdNote.textContent = 'Just created. Not live. Open Edit to assign any uploaded pictures to scenes.';
    }
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
    action('Version History', () => openVersionHistory(entry.id, entry.title));
    action('Rename', () => showLibraryRename(item, entry));
    const deleteButton = action('Delete', () => beginDeleteProduction(entry, deleteButton));
    if (isLive) {
      deleteButton.disabled = true;
      deleteButton.setAttribute('aria-label', `Delete unavailable while ${entry.title || 'this production'} is live. Set another production as Live first.`);
      deleteButton.title = 'Set another production as Live before deleting this one.';
    }
    const liveButton = action('Set as Live', () => beginLibrarySetLive(entry));
    if (headIsLive) {
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

    item.append(head, meta);
    if (createdNote) item.append(createdNote);
    item.append(actions, rename);
    item._renameForm = rename;
    ui.list.append(item);
  });
  if (createSession) {
    ui.list.hidden = true;
    ui.empty.hidden = true;
    hideAddForm(ui, true);
    ui.create.hidden = false;
    ui.createOpen.hidden = true;
    ui.access.hidden = true;
  }
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
  ui.images.hidden = true;
  ui.history.hidden = true;
  ui.confirm.hidden = true;
  ui.workspace.inert = false;
  const kept = options && options.status ? options.status : '';
  const resumeCreate = Boolean(createSession && createSession.created);
  if (resumeCreate) {
    ui.preview.hidden = true;
    ui.previewBody.replaceChildren();
    revokePreviewUrls();
    hideAddForm(ui, true);
    ui.list.hidden = true;
    ui.empty.hidden = true;
    ui.create.hidden = false;
    ui.createOpen.hidden = true;
  } else {
    hideLibraryPreview();
  }
  setLibraryStatus(kept || 'Loading saved scripts…', 'status');
  const access = await request('/api/library/access').then((response) => response.json()).catch(() => null);
  if (access && access.required && !staffToken()) {
    ui.access.hidden = false;
    hideAddForm(ui, true);
    ui.list.hidden = true;
    ui.empty.hidden = true;
    ui.create.hidden = true;
    ui.createOpen.hidden = true;
    setLibraryStatus('Enter the staff access code to open the script library.', 'status');
    ui.token.focus();
    return;
  }
  ui.access.hidden = true;
  if (!resumeCreate) hideAddForm(ui, false);
  await refreshLibrary(resumeCreate ? '' : kept);
  if (resumeCreate && createSession && createSession.created) {
    renderCreateForm();
    const failed = createSession.results.some((item) => item.status === 'failed');
    setCreateStatus(describeCreateResult(createSession), failed ? 'alert' : 'status');
    if (!ui.createEdit.hidden) ui.createEdit.focus();
    return;
  }
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
      hideAddForm(ui, true);
      ui.create.hidden = true;
      ui.createOpen.hidden = true;
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
    if (!createSession && ui.preview.hidden && ui.images.hidden && ui.history.hidden) {
      ui.access.hidden = true;
      hideAddForm(ui, false);
      ui.create.hidden = true;
      ui.createOpen.hidden = false;
      ui.list.hidden = false;
      ui.empty.hidden = libraryEntries.length > 0;
    }
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
    if (body.tracked === true && body.unchanged === true) {
      await refreshLibrary(`“${body.script.title}” already matches the live show. A second copy was not created. The live show was not changed.`);
      return body.script;
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

function blankCreateSession() {
  return {
    script: null,
    card: null,
    scenes: [],
    created: null,
    results: [],
    submitting: false,
    creationAttempts: {},
  };
}

function creationAttempt(session, title, text) {
  const key = `${String(title)}\n${String(text)}`;
  if (!session.creationAttempts) session.creationAttempts = {};
  if (!Object.prototype.hasOwnProperty.call(session.creationAttempts, key)) {
    session.creationAttempts[key] = { id: newRequestId(), sent: false };
  }
  return session.creationAttempts[key];
}

function objectUrlApi() {
  return objectUrls || null;
}

function makeObjectUrl(file) {
  const api = objectUrlApi();
  if (!api || typeof api.createObjectURL !== 'function') return '';
  try { return api.createObjectURL(file); }
  catch (err) { return ''; }
}

function dropObjectUrl(url) {
  if (!url) return;
  const api = objectUrlApi();
  if (!api || typeof api.revokeObjectURL !== 'function') return;
  try { api.revokeObjectURL(url); }
  catch (err) { /* The preview is already gone. */ }
}

function releaseCreateFiles(session) {
  if (!session) return;
  if (session.card) dropObjectUrl(session.card.url);
  session.scenes.forEach((scene) => dropObjectUrl(scene.url));
  session.card = null;
  session.scenes = [];
}

function chosenFiles(input) {
  const list = input && input.files ? input.files : [];
  const files = [];
  for (let index = 0; index < list.length; index += 1) files.push(list[index]);
  return files;
}

function clearFileInput(input) {
  if (!input) return;
  try { input.value = ''; }
  catch (err) { /* A test double may not accept a file-input reset. */ }
}

function setCreateStatus(message, tone) {
  const status = libraryDom().createStatus;
  status.dataset.tone = tone || 'status';
  status.textContent = message || '';
  status.setAttribute('role', tone === 'alert' ? 'alert' : 'status');
}

function uploadRecord(session, key) {
  return session.results.find((item) => item.key === key) || null;
}

function uploadSucceeded(session, key) {
  const record = uploadRecord(session, key);
  return Boolean(record && record.status === 'uploaded');
}

function rememberUpload(session, record) {
  session.results = session.results.filter((item) => item.key !== record.key).concat(record);
}

function pruneUploadResults(session) {
  const keys = new Set();
  if (session.card) keys.add('card');
  session.scenes.forEach((scene) => keys.add(scene.key));
  session.results = session.results.filter((item) => keys.has(item.key));
}

function createUploadQueue(session) {
  const queue = [];
  if (session.card && !uploadSucceeded(session, 'card')) {
    queue.push({
      key: 'card',
      name: session.card.name,
      file: session.card.file,
      assetId: session.card.assetId,
    });
  }
  session.scenes.forEach((scene) => {
    if (uploadSucceeded(session, scene.key)) return;
    queue.push({
      key: scene.key,
      name: scene.name,
      file: scene.file,
      assetId: scene.assetId,
    });
  });
  return queue;
}

function imageDirectives(text) {
  if (!ScriptLibrary || typeof ScriptLibrary.parseImageReference !== 'function') return [];
  const found = [];
  String(text || '').split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*@image:\s*(.*?)\s*$/);
    if (!match) return;
    found.push(ScriptLibrary.parseImageReference(match[1]));
  });
  return found;
}

function describeCreateResult(session) {
  if (!session || !session.created) return '';
  const lines = [`Created “${session.created.title}”. It is not the live show.`];
  const uploaded = session.results.filter((item) => item.status === 'uploaded');
  const failed = session.results.filter((item) => item.status === 'failed');
  if (uploaded.length) {
    lines.push(`Uploaded to this production only: ${uploaded.map((item) => item.name).join(', ')}.`);
    lines.push('These pictures are not assigned to scenes. Open Edit and choose a picture for each scene.');
  } else if (!failed.length) {
    lines.push('No pictures were added. Open Edit if you want to assign images later.');
  }
  if (failed.length) {
    lines.push(`Not uploaded: ${failed.map((item) => `${item.name} (${item.error})`).join('; ')}.`);
    lines.push('The production was kept. Retry uploads the pictures that failed without creating another production. This is not an all-or-nothing save.');
  }
  const directives = imageDirectives(session.script && session.script.text);
  const legacy = [];
  const unresolved = [];
  directives.forEach((parsed) => {
    if (parsed.kind === 'legacy' && legacy.indexOf(parsed.path) === -1) legacy.push(parsed.path);
    else if (parsed.kind === 'unknown') unresolved.push('unrecognized image line');
    else if (parsed.kind === 'library' && parsed.scriptId !== session.created.id) {
      unresolved.push('image from another production');
    }
  });
  if (legacy.length) {
    lines.push(`The script still names shared images: ${legacy.join(', ')}. Uploading a file with the same name does not change those lines.`);
  }
  if (unresolved.length) {
    lines.push('Some image lines are still unresolved and were left unchanged.');
  }
  return lines.join(' ');
}

function createReviewText(session) {
  const scriptName = session.script ? session.script.name : 'none selected';
  const cardName = session.card ? session.card.name : 'none';
  const sceneNames = session.scenes.length
    ? session.scenes.map((scene) => scene.name).join(', ')
    : 'none';
  const waiting = session.created
    ? ''
    : ' Nothing is saved until you choose Create Production. The live show will not change.';
  return `Script: ${scriptName}. Title card: ${cardName}. Scene images: ${sceneNames}.${waiting}`;
}

function renderCreateForm() {
  const session = createSession;
  if (!session) return;
  const ui = libraryDom();
  const locked = session.submitting || Boolean(session.created);
  ui.createTitle.disabled = locked;
  ui.createScript.disabled = locked;
  ui.createCard.disabled = session.submitting;
  ui.createScenes.disabled = session.submitting;
  ui.createSubmit.disabled = session.submitting || Boolean(session.created);
  ui.createCancel.disabled = session.submitting;
  ui.createCancel.textContent = session.created ? 'Back to library' : 'Cancel';
  ui.create.setAttribute('aria-busy', session.submitting ? 'true' : 'false');
  ui.createScriptPicked.hidden = !session.script;
  ui.createScriptName.textContent = session.script ? session.script.name : '';
  ui.createScriptClear.disabled = locked;
  const cardRecord = session.card ? uploadRecord(session, 'card') : null;
  ui.createCardPicked.hidden = !session.card;
  ui.createCardName.textContent = session.card
    ? cardStatusText(session.card.name, cardRecord)
    : '';
  if (session.card && session.card.url) {
    ui.createCardPreview.src = session.card.url;
    ui.createCardPreview.alt = `Preview of ${session.card.name}`;
  } else if (typeof ui.createCardPreview.removeAttribute === 'function') {
    ui.createCardPreview.removeAttribute('src');
    ui.createCardPreview.alt = '';
  }
  ui.createCardClear.disabled = session.submitting || Boolean(cardRecord && cardRecord.status === 'uploaded');
  ui.createCardClear.hidden = Boolean(cardRecord && cardRecord.status === 'uploaded');
  ui.createSceneList.replaceChildren();
  session.scenes.forEach((scene) => {
    const record = uploadRecord(session, scene.key);
    const row = doc.createElement('div');
    row.className = 'library-picked';
    if (scene.url) {
      const preview = doc.createElement('img');
      preview.src = scene.url;
      preview.alt = `Preview of ${scene.name}`;
      row.append(preview);
    }
    const name = doc.createElement('p');
    name.textContent = cardStatusText(scene.name, record);
    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'btn';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${scene.name}`);
    remove.disabled = session.submitting || Boolean(record && record.status === 'uploaded');
    remove.hidden = Boolean(record && record.status === 'uploaded');
    remove.addEventListener('click', () => removeCreateScene(scene.key));
    row.append(name, remove);
    ui.createSceneList.append(row);
  });
  const queue = createUploadQueue(session);
  const failed = session.results.some((item) => item.status === 'failed');
  ui.createRetry.hidden = !session.created || queue.length === 0;
  ui.createRetry.disabled = session.submitting;
  ui.createRetry.textContent = failed ? 'Retry failed images' : 'Upload remaining images';
  ui.createEdit.hidden = !session.created;
  ui.createEdit.disabled = session.submitting;
  ui.createReview.textContent = createReviewText(session);
}

function cardStatusText(name, record) {
  if (record && record.status === 'uploaded') return `${name} — uploaded, not assigned to a scene`;
  if (record && record.status === 'failed') return `${name} — ${record.error}`;
  return name;
}

function openCreateForm() {
  if (createSession && createSession.submitting) return;
  if (!createSession || createSession.created) return;
  const ui = libraryDom();
  ui.preview.hidden = true;
  ui.images.hidden = true;
  hideAddForm(ui, true);
  ui.list.hidden = true;
  ui.empty.hidden = true;
  ui.create.hidden = false;
  ui.createOpen.hidden = true;
  renderCreateForm();
  setLibraryStatus('', 'status');
  setCreateStatus('Choose a title and a script file. Files stay on this screen until you choose Create Production.', 'status');
  ui.createTitle.focus();
}

function discardCreateDraft() {
  releaseCreateFiles(createSession);
  createSession = null;
  createScriptToken += 1;
  const ui = libraryDom();
  ui.createTitle.value = '';
  clearFileInput(ui.createScript);
  clearFileInput(ui.createCard);
  clearFileInput(ui.createScenes);
  ui.createStatus.textContent = '';
  ui.createStatus.dataset.tone = 'status';
  ui.createReview.textContent = '';
  ui.createSceneList.replaceChildren();
  ui.createScriptPicked.hidden = true;
  ui.createCardPicked.hidden = true;
  ui.create.hidden = true;
  ui.createOpen.hidden = false;
  ui.create.setAttribute('aria-busy', 'false');
}

function finishCreateForm() {
  if (!createSession || createSession.submitting) return;
  const created = createSession.created;
  const failed = createSession.results.filter((item) => item.status === 'failed');
  discardCreateDraft();
  revealLibraryHome();
  if (created) {
    const extra = failed.length
      ? ` ${failed.length} image ${failed.length === 1 ? 'upload' : 'uploads'} did not finish. The production was kept.`
      : ' Open Edit to assign pictures to scenes.';
    setLibraryStatus(`“${created.title}” is in the library and is not live.${extra}`, failed.length ? 'alert' : 'status');
  } else {
    setLibraryStatus('Create Production was cancelled. Nothing was added.', 'status');
  }
  libraryDom().createOpen.focus();
}

function armFilePicker() {
  filePickerOpen = true;
  if (filePickerRelease) {
    clearTimeout(filePickerRelease);
    filePickerRelease = null;
  }
}

function releaseFilePicker() {
  if (!filePickerOpen) return;
  if (filePickerRelease) clearTimeout(filePickerRelease);
  filePickerRelease = setTimeout(() => {
    filePickerOpen = false;
    filePickerRelease = null;
  }, 300);
}

function settleFilePicker() {
  filePickerOpen = false;
  if (filePickerRelease) {
    clearTimeout(filePickerRelease);
    filePickerRelease = null;
  }
}

function watchFilePicker(input) {
  if (!input || typeof input.addEventListener !== 'function') return;
  input.addEventListener('click', armFilePicker);
  input.addEventListener('cancel', (event) => {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    armFilePicker();
    releaseFilePicker();
  });
  input.addEventListener('change', settleFilePicker);
}

function beginCreateForm() {
  if (createSession && createSession.submitting) return;
  if (createSession && createSession.created) {
    openResumedCreateForm();
    return;
  }
  if (!createSession) {
    createSession = blankCreateSession();
    const ui = libraryDom();
    ui.createTitle.value = '';
    clearFileInput(ui.createScript);
    clearFileInput(ui.createCard);
    clearFileInput(ui.createScenes);
  }
  openCreateForm();
}

function openResumedCreateForm() {
  const ui = libraryDom();
  ui.preview.hidden = true;
  ui.images.hidden = true;
  hideAddForm(ui, true);
  ui.list.hidden = true;
  ui.empty.hidden = true;
  ui.create.hidden = false;
  ui.createOpen.hidden = true;
  renderCreateForm();
}

async function onCreateScriptChosen() {
  const ui = libraryDom();
  const file = chosenFiles(ui.createScript)[0];
  clearFileInput(ui.createScript);
  if (!createSession || createSession.submitting || createSession.created) return;
  if (!file) return;
  const token = createScriptToken + 1;
  createScriptToken = token;
  if (file.size > 5 * 1024 * 1024) {
    setCreateStatus('That file is too large. The library accepts a plain-text script up to 5 MB.', 'alert');
    return;
  }
  let text = '';
  try {
    text = await file.text();
  } catch (err) {
    if (createScriptToken !== token || !createSession) return;
    setCreateStatus('That file could not be read. Nothing was created.', 'alert');
    return;
  }
  if (createScriptToken !== token || !createSession || createSession.created) return;
  createSession.script = { name: file.name || 'script.txt', text };
  renderCreateForm();
  setCreateStatus('Script file ready. It has not been uploaded.', 'status');
}

function onCreateCardChosen() {
  const ui = libraryDom();
  const file = chosenFiles(ui.createCard)[0];
  clearFileInput(ui.createCard);
  if (!createSession || createSession.submitting || !file) return;
  if (uploadSucceeded(createSession, 'card')) {
    setCreateStatus('The title card is already uploaded. Choosing another file did not replace it.', 'status');
    return;
  }
  if (createSession.card) dropObjectUrl(createSession.card.url);
  createSession.card = {
    name: file.name || 'Image',
    file,
    url: makeObjectUrl(file),
    assetId: newRequestId(),
  };
  createSession.results = createSession.results.filter((item) => item.key !== 'card');
  renderCreateForm();
  setCreateStatus('Title card ready. It has not been uploaded.', 'status');
}

function onCreateScenesChosen() {
  const ui = libraryDom();
  const files = chosenFiles(ui.createScenes);
  clearFileInput(ui.createScenes);
  if (!createSession || createSession.submitting || !files.length) return;
  files.forEach((file) => {
    createSceneKey += 1;
    createSession.scenes.push({
      key: `scene-${createSceneKey}`,
      name: file.name || 'Image',
      file,
      url: makeObjectUrl(file),
      assetId: newRequestId(),
    });
  });
  renderCreateForm();
  setCreateStatus('Scene images ready. They have not been uploaded.', 'status');
}

function clearCreateScript() {
  if (!createSession || createSession.submitting || createSession.created) return;
  createScriptToken += 1;
  createSession.script = null;
  renderCreateForm();
  setCreateStatus('Script file removed. Nothing was created.', 'status');
}

function clearCreateCard() {
  if (!createSession || createSession.submitting || !createSession.card) return;
  if (uploadSucceeded(createSession, 'card')) return;
  dropObjectUrl(createSession.card.url);
  createSession.card = null;
  createSession.results = createSession.results.filter((item) => item.key !== 'card');
  renderCreateForm();
  setCreateStatus('Title card removed. Nothing was uploaded.', 'status');
}

function removeCreateScene(key) {
  if (!createSession || createSession.submitting) return;
  if (uploadSucceeded(createSession, key)) return;
  const scene = createSession.scenes.find((item) => item.key === key);
  if (!scene) return;
  dropObjectUrl(scene.url);
  createSession.scenes = createSession.scenes.filter((item) => item.key !== key);
  createSession.results = createSession.results.filter((item) => item.key !== key);
  renderCreateForm();
  setCreateStatus(`${scene.name} removed. Nothing was uploaded.`, 'status');
}

async function postCreateProduction(title, text) {
  const attempt = creationAttempt(createSession, title, text);
  if (attempt.sent && !attempt.id) {
    setCreateStatus('This browser could not keep a stable creation id, so the production was not submitted again.', 'alert');
    return { identityBlocked: true };
  }
  const headers = { 'Content-Type': 'application/json' };
  if (attempt.id) headers['X-Creation-Request-Id'] = attempt.id;
  attempt.sent = true;
  const response = await libraryFetch('/api/library', {
    method: 'POST',
    headers,
    body: JSON.stringify({ title, text, trackIfCurrent: false }),
  });
  const body = await readLibraryJson(response);
  if (response.status === 401) {
    setStaffToken('');
    const ui = libraryDom();
    ui.access.hidden = false;
    ui.create.hidden = true;
    setLibraryStatus('The staff access code was not accepted.', 'alert');
    setCreateStatus('The staff access code was not accepted. Nothing was created.', 'alert');
    ui.token.focus();
    return { staffRejected: true };
  }
  if (!response.ok || !body || !body.script || !body.script.id) {
    setCreateStatus(libraryErrorMessage(response, body, 'The production was not created. The live show was not changed.'), 'alert');
    return null;
  }
  if (createSession) createSession.creationAttempts = {};
  return {
    id: body.script.id,
    title: body.script.title,
    revision: body.script.revision,
  };
}

async function postCreateAsset(scriptId, file, assetId) {
  const headers = {
    'Content-Type': file.type || 'application/octet-stream',
    'X-Asset-Name': encodeURIComponent(file.name || 'Image'),
  };
  if (assetId) headers['X-Asset-Id'] = assetId;
  const response = await libraryFetch(`/api/library/${scriptId}/assets`, {
    method: 'POST',
    headers,
    body: file,
  });
  const body = await readLibraryJson(response);
  if (response.status === 401) {
    return { ok: false, status: 401, error: 'The staff access code was not accepted.' };
  }
  if (!response.ok || !body || !body.asset) {
    return {
      ok: false,
      status: response.status,
      error: libraryErrorMessage(response, body, 'That image was not uploaded.'),
    };
  }
  return { ok: true, status: response.status, name: body.asset.name || file.name || 'Image' };
}

async function uploadQueuedAssets(session, retry) {
  pruneUploadResults(session);
  const queue = createUploadQueue(session);
  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    if (retry && !item.assetId) {
      rememberUpload(session, {
        key: item.key,
        name: item.name,
        status: 'failed',
        error: 'This browser could not keep a stable image id, so that image was not uploaded again.',
      });
      continue;
    }
    setCreateStatus(`Uploading ${index + 1} of ${queue.length}: ${item.name}`, 'status');
    try {
      const outcome = await postCreateAsset(session.created.id, item.file, item.assetId);
      if (outcome.status === 401) {
        rememberUpload(session, {
          key: item.key,
          name: item.name,
          status: 'failed',
          error: outcome.error,
        });
        setStaffToken('');
        const ui = libraryDom();
        ui.access.hidden = false;
        setLibraryStatus('The staff access code was not accepted.', 'alert');
        return;
      }
      if (outcome.ok) {
        rememberUpload(session, {
          key: item.key,
          name: outcome.name,
          status: 'uploaded',
          error: '',
        });
      } else {
        rememberUpload(session, {
          key: item.key,
          name: item.name,
          status: 'failed',
          error: outcome.error,
        });
      }
    } catch (err) {
      rememberUpload(session, {
        key: item.key,
        name: item.name,
        status: 'failed',
        error: 'That image was not uploaded. The live show was not changed.',
      });
    }
  }
}

async function runCreateSubmission(retry) {
  if (!createSession || createSession.submitting) return;
  if (retry && !createSession.created) return;
  if (!retry && createSession.created) return;
  const ui = libraryDom();
  if (!retry) {
    const title = ui.createTitle.value;
    if (!String(title || '').trim()) {
      setCreateStatus('Enter a production title.', 'alert');
      ui.createTitle.focus();
      return;
    }
    if (!createSession.script) {
      setCreateStatus('Choose a .txt script file. Choosing the file does not create a production.', 'alert');
      ui.createScript.focus();
      return;
    }
    const checked = ScriptEditor.validate(createSession.script.text);
    if (!checked.ok) {
      setCreateStatus(checked.errors.map((error) => error.message).join(' '), 'alert');
      return;
    }
  } else if (!createUploadQueue(createSession).length) {
    return;
  }
  if (!libraryGuard.tryStart()) {
    setCreateStatus('Wait for the current library action to finish.', 'alert');
    return;
  }
  createSession.submitting = true;
  renderCreateForm();
  let staffRejected = false;
  try {
    if (!createSession.created) {
      setCreateStatus('Creating the production…', 'status');
      const created = await postCreateProduction(ui.createTitle.value, createSession.script.text);
      if (!created || created.staffRejected || created.identityBlocked) {
        staffRejected = Boolean(created && created.staffRejected);
        return;
      }
      createSession.created = created;
      libraryHighlightId = created.id;
    }
    await uploadQueuedAssets(createSession, retry);
    const failures = createSession.results.filter((item) => item.status === 'failed');
    const short = failures.length
      ? `Created “${createSession.created.title}”, but ${failures.length} image ${failures.length === 1 ? 'upload' : 'uploads'} failed. The production was kept and is not live.`
      : `Created “${createSession.created.title}”. It is not the live show.`;
    await refreshLibrary(short);
    setCreateStatus(describeCreateResult(createSession), failures.length ? 'alert' : 'status');
  } catch (err) {
    const kept = createSession && createSession.created
      ? `“${createSession.created.title}” was created and kept. The live show was not changed.`
      : 'The production was not created. The live show was not changed.';
    setCreateStatus(kept, 'alert');
  } finally {
    if (createSession) createSession.submitting = false;
    libraryGuard.finish();
    renderCreateForm();
    if (staffRejected) {
      ui.access.hidden = false;
      ui.create.hidden = true;
      ui.token.focus();
      return;
    }
    if (createSession && createSession.created) {
      const failed = createSession.results.some((item) => item.status === 'failed');
      if (!failed) {
        const message = describeCreateResult(createSession);
        finishCreateForm();
        if (message) setLibraryStatus(message, 'status');
        return;
      }
      if (!ui.createRetry.hidden) ui.createRetry.focus();
      else ui.createEdit.focus();
    }
  }
}

function openCreatedInEditor() {
  if (!createSession || !createSession.created || createSession.submitting) return;
  const entry = createSession.created;
  const failed = createSession.results.some((item) => item.status === 'failed');
  if (!failed) finishCreateForm();
  editLibraryScript(entry);
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
    const partial = ScriptLibrary.partialSaveOutcome(body);
    if (partial) {
      if (partial.titleSaved && body.script) {
        await refreshLibrary(partial.message);
        return;
      }
      setLibraryStatus(partial.message, 'alert');
      return;
    }
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

function savedHeadIsLive(entry, productionIsLive) {
  if (entry && entry.liveVersionId && entry.versionId) {
    return entry.liveVersionId === entry.versionId;
  }
  return Boolean(productionIsLive);
}

function beginLibrarySetLive(entry) {
  const productionIsLive = Boolean(entry && (entry.live || entry.id === liveShow.getLiveScriptId()));
  if (savedHeadIsLive(entry, productionIsLive)) return;
  if (!libraryGuard.tryStart()) return;
  libraryGuard.finish();
  libraryPendingId = entry.id;
  libraryPendingRevision = ScriptLibrary.reviewedLiveRevision(entry, libraryReviewed);
  libraryPendingReview = false;
  const ui = libraryDom();
  const noLiveYet = !liveShow.getLiveScriptId() && !libraryLiveIdCached;
  const content = ScriptLibrary.liveSwitchConfirmContent(noLiveYet ? 'No script is live yet' : libraryCurrentTitle(), entry.title);
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
  ui.confirm.dataset.mode = '';
  ui.confirmYes.textContent = ScriptLibrary.setLiveRequestState(false).label;
  ui.confirmYes.disabled = false;
  ui.confirmNo.disabled = false;
  ui.workspace.inert = true;
  ui.confirm.hidden = false;
  ui.confirmYes.focus();
}

function restoreConfirmAction(ui) {
  ui.confirmYes.classList.remove('danger');
  ui.confirmYes.classList.add('primary');
  ui.confirmYes.textContent = 'Set as Live';
}

function hideLibraryConfirm() {
  historyCheckToken += 1;
  const ui = libraryDom();
  const returnFocus = ui.confirm.dataset.mode === 'delete-production' ? libraryDeleteTrigger : null;
  libraryPendingId = null;
  libraryPendingRevision = '';
  libraryPendingReview = false;
  libraryPendingAsset = null;
  libraryPendingDelete = null;
  libraryDeleteTrigger = null;
  ui.confirm.dataset.mode = '';
  ui.confirm.dataset.sourceVersionId = '';
  ui.confirm.dataset.expectedVersionId = '';
  ui.confirm.dataset.confirmCurrentImages = '';
  ui.confirm.hidden = true;
  ui.confirmStatus.textContent = '';
  ui.confirmStatus.classList.remove('editor-error');
  restoreConfirmAction(ui);
  ui.workspace.inert = false;
  if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
}

function beginDeleteProduction(entry, trigger) {
  const productionIsLive = Boolean(entry && (entry.live || entry.id === liveShow.getLiveScriptId()));
  if (productionIsLive || libraryDeleteBusy) return;
  if (!libraryGuard.tryStart()) return;
  libraryGuard.finish();
  const title = entry.title || 'Untitled script';
  libraryPendingDelete = {
    id: entry.id,
    title,
    generation: entry.generation,
    revision: entry.revision || '',
  };
  libraryDeleteTrigger = trigger || null;
  libraryPendingId = null;
  libraryPendingRevision = '';
  libraryPendingReview = false;
  libraryPendingAsset = null;
  const ui = libraryDom();
  ui.confirmBody.replaceChildren();
  ui.confirmStatus.textContent = '';
  ui.confirmStatus.classList.remove('editor-error');
  ui.confirmHeading.textContent = `Permanently delete '${title}'?`;
  const removed = doc.createElement('p');
  removed.className = 'editor-confirm-message';
  removed.textContent = 'This will delete the production, all saved versions, and its associated images from this library.';
  const permanent = doc.createElement('p');
  permanent.className = 'editor-confirm-message';
  permanent.textContent = 'This action cannot be undone in the app.';
  ui.confirmBody.append(removed, permanent);
  ui.confirm.dataset.mode = 'delete-production';
  ui.confirmYes.classList.remove('primary');
  ui.confirmYes.classList.add('danger');
  ui.confirmYes.textContent = 'Delete Permanently';
  ui.confirmNo.textContent = 'Cancel';
  ui.confirmYes.disabled = false;
  ui.confirmNo.disabled = false;
  ui.workspace.inert = true;
  ui.confirm.hidden = false;
  ui.confirmNo.focus();
}

async function runDeleteProduction() {
  if (libraryDeleteBusy || !libraryPendingDelete || !libraryGuard.tryStart()) return;
  libraryDeleteBusy = true;
  const pending = libraryPendingDelete;
  const ui = libraryDom();
  ui.confirmYes.disabled = true;
  ui.confirmNo.disabled = true;
  ui.confirm.setAttribute('aria-busy', 'true');
  ui.confirmYes.textContent = 'Deleting…';
  try {
    const response = await libraryFetch(`/api/library/${pending.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedGeneration: pending.generation,
        expectedRevision: pending.revision,
      }),
    });
    const body = await readLibraryJson(response);
    if (response.status === 401) {
      setStaffToken('');
      libraryDeleteTrigger = null;
      hideLibraryConfirm();
      ui.access.hidden = false;
      hideAddForm(ui, true);
      ui.list.hidden = true;
      ui.empty.hidden = true;
      ui.create.hidden = true;
      ui.createOpen.hidden = true;
      setLibraryStatus('The staff access code was not accepted.', 'alert');
      ui.token.focus();
      return;
    }
    if (!response.ok) {
      ui.confirmStatus.classList.add('editor-error');
      ui.confirmStatus.textContent = libraryErrorMessage(response, body, 'That production was not deleted. The live show was not changed.');
      ui.confirmYes.disabled = false;
      ui.confirmNo.disabled = false;
      ui.confirmYes.textContent = 'Delete Permanently';
      ui.confirmNo.focus();
      if (body && body.code === 'missing-production') await refreshLibrary('');
      return;
    }
    const title = pending.title;
    libraryDeleteTrigger = null;
    hideLibraryConfirm();
    await refreshLibrary(`Permanently deleted “${title}” from this library. This cannot be undone in the app. The live show was not changed.`);
    const close = doc.getElementById('library-close');
    if (close) close.focus();
  } catch (err) {
    ui.confirmStatus.classList.add('editor-error');
    ui.confirmStatus.textContent = 'That production was not deleted. The live show was not changed.';
    ui.confirmYes.disabled = false;
    ui.confirmNo.disabled = false;
    ui.confirmYes.textContent = 'Delete Permanently';
    ui.confirmNo.focus();
  } finally {
    libraryDeleteBusy = false;
    libraryGuard.finish();
    ui.confirm.setAttribute('aria-busy', 'false');
  }
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
  ui.confirm.dataset.mode = '';
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
  hideAddForm(ui, true);
  ui.list.hidden = true;
  ui.empty.hidden = true;
  ui.create.hidden = true;
  ui.createOpen.hidden = true;
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
  const signature = manageFileSignature(file);
  let assetId = null;
  if (manageAsset && manageAsset.failed && manageAsset.signature === signature && manageAsset.id) {
    assetId = manageAsset.id;
  } else {
    assetId = newRequestId();
  }
  manageAsset = { id: assetId, signature, failed: false };
  setImageStatus('Uploading image…', 'status');
  try {
    const headers = {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Asset-Name': encodeURIComponent(file.name || 'Image'),
    };
    if (assetId) headers['X-Asset-Id'] = assetId;
    const response = await libraryFetch(`/api/library/${libraryImagesScriptId}/assets`, {
      method: 'POST',
      headers,
      body: file,
    });
    const body = await readLibraryJson(response);
    if (!response.ok || !body || !body.asset) {
      if (manageAsset) manageAsset.failed = true;
      setImageStatus(libraryErrorMessage(response, body, 'That image was not uploaded.'), 'alert');
      return;
    }
    manageAsset = null;
    setImageStatus(`Uploaded “${body.asset.name}”. The live show was not changed.`, 'status');
    await refreshLibraryImages();
  } catch (err) {
    if (manageAsset) manageAsset.failed = true;
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

function savedTimeLabel(createdAt) {
  if (typeof createdAt !== 'string' || createdAt.trim() === '') return 'Original save time unavailable';
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return 'Original save time unavailable';
  return `Saved ${date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
}

function versionSequence(versions) {
  const list = versions.filter((version) => version && version.versionId);
  const numbered = new Map();
  if (list.length && list.every((version) => Number.isInteger(version.sequence) && version.sequence >= 1)) {
    list.forEach((version) => numbered.set(version.versionId, version.sequence));
    return numbered;
  }
  const children = new Map();
  list.forEach((version) => children.set(version.versionId, []));
  const roots = [];
  list.forEach((version) => {
    const parent = version.parentVersionId;
    if (parent && children.has(parent) && parent !== version.versionId) children.get(parent).push(version.versionId);
    else roots.push(version.versionId);
  });
  const seen = new Set();
  let next = 1;
  function walk(id) {
    if (seen.has(id)) return;
    seen.add(id);
    numbered.set(id, next);
    next += 1;
    (children.get(id) || []).forEach(walk);
  }
  roots.forEach(walk);
  list.forEach((version) => walk(version.versionId));
  return numbered;
}

function historyOrder(versions) {
  const sequence = versionSequence(versions);
  return versions.slice().sort((left, right) => {
    const leftNumber = sequence.get(left.versionId) || 0;
    const rightNumber = sequence.get(right.versionId) || 0;
    return rightNumber - leftNumber;
  });
}

function versionLabel(versionId, sequence) {
  const number = sequence && sequence.get(versionId);
  return number ? `Version ${number}` : 'Saved version';
}

function revokeHistoryUrls() {
  if (!objectUrls) {
    historyObjectUrls.length = 0;
    return;
  }
  historyObjectUrls.splice(0).forEach((url) => {
    try { objectUrls.revokeObjectURL(url); } catch (err) { /* The preview is already gone. */ }
  });
}

function setHistoryStatus(message, tone) {
  const status = libraryDom().historyStatus;
  status.dataset.tone = tone || 'status';
  status.textContent = message || '';
  status.setAttribute('role', tone === 'alert' ? 'alert' : 'status');
}

function hideVersionHistory() {
  const ui = libraryDom();
  revokeHistoryUrls();
  historyProductionId = null;
  historyDetail = null;
  ui.history.hidden = true;
  ui.historyPreview.hidden = true;
  ui.historyList.replaceChildren();
  ui.historyWarning.hidden = true;
  ui.historyWarning.textContent = '';
  if (ui.historyPreviewText) ui.historyPreviewText.textContent = '';
  if (ui.historyPreviewImages) ui.historyPreviewImages.replaceChildren();
  const previewId = doc.getElementById('library-history-preview-id');
  if (previewId) previewId.textContent = '';
}

function versionMarks(version) {
  const marks = [];
  if (version.savedHead) marks.push('Latest Saved');
  if (version.live) marks.push('Live Now');
  if (version.previousLive) marks.push('Previous live');
  if (version.origin === 'original') marks.push('Original');
  if (version.origin === 'migrated') marks.push('Migrated');
  return marks;
}

function versionImageNote(version) {
  if (!version || version.imageBytesImmutable !== false) return '';
  if (version.legacyImagePolicy === 'shared-images') {
    return 'Uses a shared image. Historical replay is not guaranteed.';
  }
  return 'Image bytes are not an immutable snapshot.';
}

function renderHistoryList() {
  const ui = libraryDom();
  const listing = historyListing;
  ui.historyList.replaceChildren();
  ui.historyPreview.hidden = true;
  revokeHistoryUrls();
  if (!listing || !Array.isArray(listing.versions)) return;
  const excluded = (Array.isArray(listing.orphans) && listing.orphans.length)
    || (Array.isArray(listing.diagnostics) && listing.diagnostics.length);
  ui.historyWarning.hidden = !excluded;
  ui.historyWarning.textContent = excluded
    ? 'Some incomplete or damaged versions were excluded from history.'
    : '';
  const committed = listing.versions.filter((version) => version && version.committed !== false);
  const sequence = versionSequence(committed);
  historyOrder(committed).forEach((version) => {
    const label = versionLabel(version.versionId, sequence);
    const card = doc.createElement('article');
    card.className = 'history-version';
    const title = doc.createElement('h4');
    title.className = 'library-title';
    title.textContent = label;
    const when = doc.createElement('p');
    when.className = 'library-meta';
    when.textContent = savedTimeLabel(version.createdAt);
    const marks = doc.createElement('p');
    marks.className = 'history-marks';
    versionMarks(version).forEach((name) => {
      const mark = doc.createElement('span');
      mark.className = 'history-mark';
      mark.textContent = name;
      marks.append(mark);
    });
    const technical = doc.createElement('details');
    technical.className = 'history-technical';
    const summary = doc.createElement('summary');
    summary.textContent = 'Technical details';
    const identity = doc.createElement('p');
    identity.className = 'library-note';
    identity.textContent = `Version id ${version.versionId}`;
    technical.append(summary, identity);
    card.append(title, when, marks, technical);
    const imageNote = versionImageNote(version);
    if (imageNote) {
      const warning = doc.createElement('p');
      warning.className = 'library-note';
      warning.textContent = imageNote;
      card.append(warning);
    }
    const actions = doc.createElement('div');
    actions.className = 'library-actions';
    const preview = doc.createElement('button');
    preview.type = 'button';
    preview.className = 'btn';
    preview.textContent = 'Preview';
    preview.setAttribute('aria-label', `Preview ${label} of ${historyTitle || 'this production'}`);
    preview.disabled = historyBusy;
    preview.addEventListener('click', () => previewHistoricalVersion(version.versionId));
    const restore = doc.createElement('button');
    restore.type = 'button';
    restore.className = 'btn';
    restore.textContent = 'Restore as New Saved Version';
    restore.setAttribute('aria-label', `Restore ${label} of ${historyTitle || 'this production'} as a new saved version`);
    restore.disabled = historyBusy;
    restore.addEventListener('click', () => beginHistoryRestore(version.versionId));
    actions.append(preview, restore);
    card.append(actions);
    ui.historyList.append(card);
  });
}

async function loadVersionHistory(keptStatus) {
  const ui = libraryDom();
  const productionId = historyProductionId;
  if (!productionId) return;
  setHistoryStatus(keptStatus || 'Loading version history…', 'status');
  let response;
  let body;
  try {
    response = await libraryFetch(`/api/library/${productionId}/versions`);
    body = await readLibraryJson(response);
  } catch (err) {
    setHistoryStatus('Version history could not be loaded. The live show was not changed.', 'alert');
    return;
  }
  if (historyProductionId !== productionId) return;
  if (response.status === 404) {
    historyListing = null;
    ui.historyList.replaceChildren();
    ui.historyWarning.hidden = true;
    setHistoryStatus('Version history is not available on this library. The saved scripts and the live show were not changed.', 'status');
    return;
  }
  if (!response.ok || !body || body.ok !== true || !Array.isArray(body.versions)) {
    setHistoryStatus(libraryErrorMessage(response, body, 'Version history could not be loaded. The live show was not changed.'), 'alert');
    return;
  }
  historyListing = body;
  renderHistoryList();
  if (!keptStatus) setHistoryStatus('', 'status');
}

async function openVersionHistory(productionId, title) {
  if (!enabled || !productionId) return;
  const ui = libraryDom();
  if (!ui.dialog.open) ui.dialog.showModal();
  ui.confirm.hidden = true;
  ui.workspace.inert = false;
  ui.preview.hidden = true;
  ui.images.hidden = true;
  hideAddForm(ui, true);
  ui.list.hidden = true;
  ui.empty.hidden = true;
  ui.create.hidden = true;
  ui.createOpen.hidden = true;
  historyProductionId = productionId;
  historyTitle = title || 'this production';
  historyDetail = null;
  ui.history.hidden = false;
  ui.historyTitle.textContent = `Version History: ${historyTitle}`;
  ui.historyPreview.hidden = true;
  const back = doc.getElementById('library-history-back');
  if (back) back.focus();
  await loadVersionHistory('');
}

function hideHistoricalPreview() {
  const ui = libraryDom();
  revokeHistoryUrls();
  historyDetail = null;
  ui.historyPreview.hidden = true;
  ui.historyPreviewText.textContent = '';
  ui.historyPreviewImages.replaceChildren();
  ui.historyPreviewMeta.textContent = '';
  const previewId = doc.getElementById('library-history-preview-id');
  if (previewId) previewId.textContent = '';
  renderHistoryList();
  const back = doc.getElementById('library-history-back');
  if (back) back.focus();
}

function previewImageStatus(images) {
  if (!images) return 'Image status was not reported.';
  const lines = [];
  if (images.imageBytesImmutable === false) {
    lines.push('Historical image replay is not guaranteed.');
  }
  (images.sharedImages || []).forEach((image) => {
    lines.push(`Shared image ${image.reference || 'reference'}: the file can still change, and it was not copied into this version.`);
  });
  (images.ownedImages || []).forEach((image) => {
    const name = image && image.name ? image.name : 'A saved image';
    lines.push(image.available
      ? `${name} is available from this production.`
      : `${name} is missing or damaged.`);
  });
  if (!lines.length) lines.push('This version does not add an image warning.');
  return lines.join(' ');
}

async function previewHistoricalVersion(versionId) {
  const ui = libraryDom();
  const productionId = historyProductionId;
  if (!productionId || !versionId || historyBusy) return;
  setHistoryStatus('Loading the historical preview…', 'status');
  let response;
  let body;
  try {
    response = await libraryFetch(`/api/library/${productionId}/versions/${versionId}`);
    body = await readLibraryJson(response);
  } catch (err) {
    setHistoryStatus('The historical version could not be previewed. The live show was not changed.', 'alert');
    return;
  }
  if (historyProductionId !== productionId) return;
  if (!response.ok || !body || !body.version || typeof body.version.text !== 'string') {
    setHistoryStatus(libraryErrorMessage(response, body, 'The historical version could not be previewed. The live show was not changed.'), 'alert');
    return;
  }
  historyDetail = body;
  revokeHistoryUrls();
  const sequence = versionSequence((historyListing && historyListing.versions) || []);
  const label = versionLabel(versionId, sequence);
  ui.historyPreview.hidden = false;
  ui.historyPreviewTitle.textContent = `Historical preview: ${label}`;
  ui.historyPreviewMeta.textContent = [
    historyTitle,
    label,
    savedTimeLabel(body.version.createdAt),
    versionMarks(body.version).join(', ') || 'Saved version',
    previewImageStatus(body.images),
  ].join('. ') + '.';
  const previewId = doc.getElementById('library-history-preview-id');
  if (previewId) previewId.textContent = `Version id ${versionId}`;
  ui.historyPreviewText.textContent = body.version.text;
  ui.historyPreviewImages.replaceChildren();
  const owned = body.images && Array.isArray(body.images.ownedImages) ? body.images.ownedImages : [];
  for (let index = 0; index < owned.length; index += 1) {
    const image = owned[index];
    if (!image || !image.available || !image.assetId) continue;
    try {
      const asset = await libraryFetch(`/api/library/${productionId}/assets/${image.assetId}`);
      if (!asset.ok || historyProductionId !== productionId) continue;
      const blob = await asset.blob();
      const url = objectUrls.createObjectURL(blob);
      historyObjectUrls.push(url);
      const picture = doc.createElement('img');
      picture.alt = image.name ? `Saved image ${image.name}` : 'Saved image for this historical version';
      picture.src = url;
      ui.historyPreviewImages.append(picture);
    } catch (err) {
      const missing = doc.createElement('p');
      missing.className = 'library-note';
      missing.textContent = image.name
        ? `${image.name} could not be shown.`
        : 'A saved image could not be shown.';
      ui.historyPreviewImages.append(missing);
    }
  }
  setHistoryStatus('This preview is read only. The saved head and the live show were not changed.', 'status');
  ui.historyPreviewText.focus();
}

function beginHistoryRestore(versionId) {
  const listing = historyListing;
  const source = listing && listing.versions && listing.versions.find((version) => version.versionId === versionId);
  if (!source || !historyProductionId || !listing || !listing.savedHeadVersionId) {
    setHistoryStatus('That saved version could not be selected. The live show was not changed.', 'alert');
    return;
  }
  if (!libraryGuard.tryStart()) return;
  libraryGuard.finish();
  libraryPendingId = null;
  libraryPendingAsset = null;
  libraryPendingReview = false;
  historyDetail = historyDetail && historyDetail.version && historyDetail.version.versionId === versionId
    ? historyDetail
    : { version: source };
  const ui = libraryDom();
  ui.confirmBody.replaceChildren();
  ui.confirmStatus.textContent = '';
  ui.confirmStatus.classList.remove('editor-error');
  ui.confirmHeading.textContent = 'Restore this saved version?';
  const message = doc.createElement('p');
  message.className = 'editor-confirm-message';
  const sequence = versionSequence((listing && listing.versions) || []);
  message.textContent = `Restore ${versionLabel(versionId, sequence)} into ${historyTitle}.`;
  const notes = doc.createElement('ul');
  notes.className = 'editor-confirm-notes';
  [
    'A new saved version is created when the text differs. If it already matches the saved head, another version is not created.',
    'The selected version and the other saved versions stay as they are.',
    'The saved head of this production can change.',
    'The live show stays as it is. Actor and Audience screens will not switch to the restored version.',
  ].forEach((note) => {
    const item = doc.createElement('li');
    item.textContent = note;
    notes.append(item);
  });
  ui.confirmBody.append(message, notes);
  ui.confirmYes.textContent = 'Restore as New Saved Version';
  ui.confirmYes.disabled = false;
  ui.confirmNo.disabled = false;
  ui.workspace.inert = true;
  ui.confirm.hidden = false;
  ui.confirmYes.focus();
  ui.confirm.dataset.mode = 'restore-saved';
  ui.confirm.dataset.sourceVersionId = versionId;
  ui.confirm.dataset.expectedVersionId = listing.savedHeadVersionId;
  ui.confirm.dataset.confirmCurrentImages = '';
  if (source.legacyImagePolicy === 'shared-images') prepareSharedRestore(versionId);
}

function withTimeout(work, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error('The restore took too long.');
      err.code = 'timeout';
      reject(err);
    }, ms);
    Promise.resolve(work).then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function sharedImageSentence(image) {
  const name = image && image.name ? image.name : 'An image';
  if (!image || image.code === 'missing-image') return `${name} is missing.`;
  if (image.code === 'unsafe-image') return `${name} is not a safe image file.`;
  if (image.code) return `${name} is not a usable image.`;
  return '';
}

function presentSharedRestore(versionId, report) {
  const ui = libraryDom();
  if (ui.confirm.dataset.sourceVersionId !== versionId || ui.confirm.hidden) return;
  const status = report && report.status;
  ui.confirm.setAttribute('aria-busy', 'false');
  ui.confirmNo.disabled = false;
  ui.confirmStatus.textContent = '';
  ui.confirmStatus.classList.remove('editor-error');
  if (!report || status === 'blocked' || report.code) {
    const images = report && Array.isArray(report.images) ? report.images : [];
    const sentences = images.map(sharedImageSentence).filter(Boolean);
    ui.confirmBody.replaceChildren();
    const refused = doc.createElement('p');
    refused.className = 'editor-confirm-message';
    refused.textContent = 'This version cannot be restored. Preview is still available.';
    ui.confirmBody.append(refused);
    ui.confirmStatus.classList.add('editor-error');
    ui.confirmStatus.textContent = `${sentences.join(' ') || 'An image in that version cannot be restored.'} Nothing was saved. The original version and the live show were not changed.`;
    ui.confirmYes.textContent = 'Not restored';
    ui.confirmYes.disabled = true;
    ui.confirmNo.focus();
    return;
  }
  if (status === 'current-shared') {
    ui.confirmBody.replaceChildren();
    const warning = doc.createElement('p');
    warning.className = 'editor-confirm-message';
    warning.textContent = 'This older version uses shared images. The images are still available, but we cannot verify that they are identical to the originals.';
    const choice = doc.createElement('p');
    choice.className = 'editor-confirm-message';
    choice.textContent = 'You can restore the script using the images currently available. This will create a new saved version without changing the original historical version.';
    ui.confirmBody.append(warning, choice);
    ui.confirmYes.textContent = 'Restore Using Current Images';
    ui.confirmYes.disabled = false;
    ui.confirm.dataset.confirmCurrentImages = 'true';
    ui.confirmYes.focus();
    return;
  }
  if (status === 'verified') {
    const notes = ui.confirmBody.querySelector('ul');
    if (notes) {
      const item = doc.createElement('li');
      item.textContent = report && report.description
        ? report.description
        : 'The shared images match a copy stored with this production. That match does not prove they are the images from the original save. Restore will keep those stored copies with this production. The original version stays unchanged.';
      notes.append(item);
    }
  }
  ui.confirmYes.textContent = 'Restore as New Saved Version';
  ui.confirmYes.disabled = false;
  ui.confirmYes.focus();
}

async function prepareSharedRestore(versionId) {
  const token = historyCheckToken;
  const ui = libraryDom();
  const productionId = historyProductionId;
  ui.confirmYes.disabled = true;
  ui.confirmYes.textContent = 'Checking…';
  ui.confirm.setAttribute('aria-busy', 'true');
  try {
    const response = await withTimeout(libraryFetch(`/api/library/${productionId}/versions/${versionId}`), 30000);
    const body = await readLibraryJson(response);
    if (token !== historyCheckToken || ui.confirm.dataset.sourceVersionId !== versionId) return;
    if (!response.ok || !body || body.ok !== true) {
      presentSharedRestore(versionId, { status: 'blocked', images: [] });
      ui.confirmStatus.textContent = restoreFailureMessage(response, body);
      return;
    }
    const report = body.images && body.images.sharedRestore;
    presentSharedRestore(versionId, report || { status: 'verified', images: [] });
  } catch (err) {
    if (token !== historyCheckToken || ui.confirm.dataset.sourceVersionId !== versionId) return;
    presentSharedRestore(versionId, { status: 'blocked', images: [] });
    ui.confirmStatus.textContent = err && err.code === 'timeout'
      ? 'Checking the images took too long. Nothing was saved, and the live show was not changed.'
      : 'The images could not be checked. Nothing was saved, and the live show was not changed.';
  }
}

function restoreAttemptKey(productionId, sourceVersionId) {
  return `prompter-restore-attempt:${productionId}:${sourceVersionId}`;
}

function storedRestoreAttempt(productionId, sourceVersionId) {
  if (!staffStorage || typeof staffStorage.getItem !== 'function') return null;
  try {
    const value = staffStorage.getItem(restoreAttemptKey(productionId, sourceVersionId));
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
      ? value
      : null;
  } catch (err) {
    return null;
  }
}

function rememberRestoreAttempt(productionId, sourceVersionId, versionId) {
  if (!staffStorage || typeof staffStorage.setItem !== 'function' || !versionId) return;
  try { staffStorage.setItem(restoreAttemptKey(productionId, sourceVersionId), versionId); }
  catch (err) { /* The in-memory id still covers this page. */ }
}

function forgetRestoreAttempt(productionId, sourceVersionId) {
  if (!staffStorage || typeof staffStorage.removeItem !== 'function') return;
  try { staffStorage.removeItem(restoreAttemptKey(productionId, sourceVersionId)); }
  catch (err) { /* The in-memory id is cleared separately. */ }
}

function stopHistoryRestore(ui, message) {
  ui.confirmStatus.classList.add('editor-error');
  ui.confirmStatus.textContent = message;
  ui.confirmYes.textContent = 'Not restored';
  ui.confirmYes.disabled = true;
  ui.confirmNo.disabled = false;
  ui.confirm.setAttribute('aria-busy', 'false');
  if (typeof ui.confirmNo.focus === 'function') ui.confirmNo.focus();
}

function restoreFailureMessage(response, body) {
  const code = body && body.code;
  if (response && response.status === 404 && (!body || !body.code)) {
    return 'Version history is not available on this library. The saved scripts and the live show were not changed.';
  }
  if (code === 'conflict') {
    return 'Another save changed the saved head after you opened this history. This restore was not repeated. Review the updated head, then confirm again if you still want to restore the same version. The live show was not changed.';
  }
  if (code === 'legacy-image') {
    return 'This version can be previewed, but it still uses a shared images/ file. Restore did not copy that image or rewrite the script. The saved head and the live show were not changed.';
  }
  if (code === 'confirmation-required') {
    return 'This older version uses shared images. The images are still available, but we cannot verify that they are identical to the originals. You can restore the script using the images currently available. This will create a new saved version without changing the original historical version.';
  }
  if (code === 'missing-image' || code === 'unsafe-image' || code === 'invalid-image') {
    return body.error || 'An image in that version cannot be restored. Nothing was saved, and the live show was not changed.';
  }
  if (code === 'orphan-version') {
    return 'That version is incomplete and is not part of saved history. It was not restored, and the live show was not changed.';
  }
  if (code === 'missing-version' || code === 'missing-production') {
    return 'That saved version could not be found. Nothing was restored, and the live show was not changed.';
  }
  if (code === 'missing-asset' || code === 'corrupt-asset') {
    return `${body.error || 'A required image could not be verified.'} The saved head and the live show were not changed.`;
  }
  if (code === 'foreign-asset') {
    return 'An image in that version belongs to another production. It was not copied, and the live show was not changed.';
  }
  if (code === 'invalid-script') {
    return `${body.error || 'That historical script is not valid.'} Nothing was restored, and the live show was not changed.`;
  }
  if (code === 'version-exists') {
    return 'That new version id was already used and was not overwritten. Another copy was not created. The live show was not changed.';
  }
  if (code === 'indeterminate' || code === 'unconfirmed-head' || code === 'storage-failure') {
    return 'The server did not confirm the result. This restore was not reported as rolled back. The same new version id will be kept if you try this restoration again. The live show was not changed.';
  }
  if (response && response.status === 401) return 'The staff access code was not accepted.';
  return libraryErrorMessage(response, body, 'The saved version was not restored. The live show was not changed.');
}

async function runHistoryRestore() {
  const ui = libraryDom();
  if (ui.confirm.dataset.mode !== 'restore-saved' || historyBusy) return;
  const productionId = historyProductionId;
  const sourceVersionId = ui.confirm.dataset.sourceVersionId;
  const expectedVersionId = ui.confirm.dataset.expectedVersionId;
  if (!productionId || !sourceVersionId || !expectedVersionId) return;
  if (historyRestoreSource !== sourceVersionId || !historyRestoreId) {
    historyRestoreId = storedRestoreAttempt(productionId, sourceVersionId) || newRequestId();
    historyRestoreSource = sourceVersionId;
  }
  rememberRestoreAttempt(productionId, sourceVersionId, historyRestoreId);
  if (!historyRestoreId) {
    ui.confirmStatus.classList.add('editor-error');
    ui.confirmStatus.textContent = 'A new version id could not be created. Nothing was restored, and the live show was not changed.';
    return;
  }
  if (!libraryGuard.tryStart()) return;
  historyBusy = true;
  ui.confirmYes.disabled = true;
  ui.confirmNo.disabled = true;
  ui.confirm.setAttribute('aria-busy', 'true');
  ui.confirmYes.textContent = 'Restoring…';
  const attemptId = historyRestoreId;
  try {
    const response = await withTimeout(libraryFetch(`/api/library/${productionId}/versions/${sourceVersionId}/restore`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Version-Id': attemptId,
      },
      body: JSON.stringify({
        expectedVersionId,
        confirmCurrentImages: ui.confirm.dataset.confirmCurrentImages === 'true',
      }),
    }), 30000);
    const body = await readLibraryJson(response);
    if (!response.ok || !body || body.ok !== true) {
      if (body && body.code === 'confirmation-required') {
        presentSharedRestore(sourceVersionId, { status: 'current-shared', images: body.sharedImages || [] });
        return;
      }
      stopHistoryRestore(ui, restoreFailureMessage(response, body));
      if (body && body.code === 'conflict') await loadVersionHistory('');
      return;
    }
    historyRestoreId = null;
    historyRestoreSource = null;
    forgetRestoreAttempt(productionId, sourceVersionId);
    const unchanged = body.unchanged === true;
    const alreadyRestored = body.alreadyRestored === true;
    const stillHead = !body.restoredVersionId || body.savedHeadVersionId === body.restoredVersionId;
    let message;
    if (alreadyRestored && stillHead) {
      message = 'That restore was already saved. Another version was not created. It is the latest saved version and it is not live. Actor and Audience screens were not changed.';
    } else if (alreadyRestored) {
      message = 'That restore was already saved. Another version was not created. The latest saved version was left as it is, and the live show was not changed.';
    } else if (unchanged) {
      message = 'This text is already the saved head. Another version was not created. The live show was not changed.';
    } else {
      message = `Saved a new version from ${versionLabel(sourceVersionId, versionSequence((historyListing && historyListing.versions) || []))}. It is the latest saved version and it is not live. Actor and Audience screens were not changed.`;
    }
    hideLibraryConfirm();
    await refreshLibrary(message);
    if (historyProductionId === productionId) await loadVersionHistory(message);
    noteSavedHead(productionId, { unchanged, message, savedHeadVersionId: body.savedHeadVersionId });
  } catch (err) {
    stopHistoryRestore(ui, err && err.code === 'timeout'
      ? 'The restore took too long and was not confirmed. The same new version id will be kept if you try this restoration again. The live show was not changed.'
      : 'The server did not confirm the result. This restore was not reported as rolled back. The same new version id will be kept if you try this restoration again. The live show was not changed.');
  } finally {
    historyBusy = false;
    libraryGuard.finish();
    ui.confirm.setAttribute('aria-busy', 'false');
  }
}

function closeLibrary() {
  const ui = libraryDom();
  if (!ui.confirm.hidden) {
    if (ui.confirm.getAttribute('aria-busy') === 'true') return;
    hideLibraryConfirm();
    return;
  }
  if (createSession && createSession.submitting) return;
  if (createSession && !createSession.created) {
    finishCreateForm();
    return;
  }
  hideLibraryPreview();
  hideLibraryImages();
  hideVersionHistory();
  if (ui.dialog.open) ui.dialog.close();
  if (isEditorOpen()) {
    const historyButton = doc.getElementById('editor-version-history');
    if (historyButton) historyButton.focus();
    return;
  }
  doc.getElementById('btn-script-library').focus();
}

function bindLibrary() {
  const ui = libraryDom();
  doc.getElementById('btn-script-library').addEventListener('click', () => openLibrary());
  doc.getElementById('library-close').addEventListener('click', closeLibrary);
  doc.getElementById('library-token-continue').addEventListener('click', continueLibraryAccess);
  if (ui.add) ui.add.addEventListener('submit', saveCurrentLiveScript);
  ui.createOpen.addEventListener('click', beginCreateForm);
  ui.create.addEventListener('submit', (event) => {
    event.preventDefault();
    return runCreateSubmission(false);
  });
  ui.createCancel.addEventListener('click', finishCreateForm);
  ui.createRetry.addEventListener('click', () => runCreateSubmission(true));
  ui.createEdit.addEventListener('click', openCreatedInEditor);
  watchFilePicker(ui.createScript);
  watchFilePicker(ui.createCard);
  watchFilePicker(ui.createScenes);
  watchFilePicker(ui.imageFile);
  ui.createScript.addEventListener('change', onCreateScriptChosen);
  ui.createCard.addEventListener('change', onCreateCardChosen);
  ui.createScenes.addEventListener('change', onCreateScenesChosen);
  ui.createScriptClear.addEventListener('click', clearCreateScript);
  ui.createCardClear.addEventListener('click', clearCreateCard);
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
    if (ui.confirm.getAttribute('aria-busy') === 'true') return;
    if (ui.confirm.dataset.mode === 'delete-production') return runDeleteProduction();
    if (ui.confirm.dataset.mode === 'restore-saved') runHistoryRestore();
    else if (libraryPendingAsset) runRemoveLibraryImage();
    else if (libraryPendingReview) reviewLatestBeforeSetLive();
    else runLibrarySetLive();
  });
  doc.getElementById('library-history-back').addEventListener('click', () => {
    hideVersionHistory();
    revealLibraryHome();
    setLibraryStatus('', 'status');
    doc.getElementById('library-close').focus();
  });
  doc.getElementById('library-history-preview-back').addEventListener('click', hideHistoricalPreview);
  ui.historyRestore.addEventListener('click', () => {
    const version = historyDetail && historyDetail.version;
    if (version) beginHistoryRestore(version.versionId);
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
    // The system file window's Cancel arrives as a cancel event on this dialog.
    // That is separate from this form's Cancel button and from Escape on the page.
    if (filePickerOpen) return;
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
      if (config.noteSavedHead) noteSavedHead = config.noteSavedHead;
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
      openHistory: openVersionHistory,
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
