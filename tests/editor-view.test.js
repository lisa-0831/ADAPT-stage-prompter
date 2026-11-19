const test = require('node:test');
const assert = require('node:assert/strict');
const { createEditorView } = require('../public/editor-view');
const ScriptEditor = require('../script-editor-model');
const ScriptLibrary = require('../script-library-model');
const ScriptFormat = require('../script-format');

function element() {
  const node = {
    open: false,
    hidden: true,
    inert: false,
    disabled: false,
    textContent: '',
    value: '',
    className: '',
    id: '',
    type: '',
    htmlFor: '',
    rows: 0,
    readOnly: false,
    tabIndex: 0,
    children: [],
    options: [],
    listeners: [],
    classList: {
      add() {},
      remove() {},
      contains() { return false; },
    },
    addEventListener(type, fn) { node.listeners.push({ type, fn }); },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    replaceChildren() { node.children = []; node.options = []; },
    append(...items) {
      node.children.push(...items);
      node.options.push(...items);
    },
    focus() {},
    showModal() { node.open = true; },
    close() { node.open = false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    remove() {},
  };
  return node;
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function harness() {
  const ids = {};
  function byId(id) {
    if (!ids[id]) ids[id] = element();
    return ids[id];
  }
  const live = {
    revision: 'rev-live',
    scriptId: 'live-1',
    getRevision() { return this.revision; },
    getLiveScriptId() { return this.scriptId; },
    setLiveScriptId(id) { this.scriptId = id; },
    getLiveState() { return null; },
    getSlides() { return []; },
  };
  const entries = [];
  const doc = {
    activeElement: null,
    getElementById: byId,
    createElement: element,
  };
  const editor = createEditorView({
    document: doc,
    fetch: async (url) => {
      if (url === '/script/previous') return { ok: false, text: async () => '' };
      if (url === '/script') return { ok: true, text: async () => '# Opening\n[ADA]\nFIRST SPOKEN LINE\n' };
      return { ok: false, text: async () => '', json: async () => null };
    },
    liveShow: live,
    ScriptEditor,
    ScriptLibrary,
    ScriptFormat,
    crypto: {},
    storage: memoryStorage(),
    window: { setTimeout() { return 0; }, clearTimeout() {} },
  });
  return { editor, ids, live, entries, byId };
}

test('editor controls stay idle until the controller initializes them', () => {
  const { editor, byId } = harness();
  assert.equal(editor.isEnabled(), false);
  assert.equal(editor.isOpen(), false);
  editor.noteScriptRevision();
  editor.init({
    libraryFetch: async () => ({ ok: true, json: async () => ({ scripts: [], liveId: null }) }),
    rememberLibraryEntries() {},
    openLibrary() {},
    getLibraryEntries() { return []; },
    libraryCurrentTitle() { return ''; },
    readLibraryJson: async (response) => response.json(),
    libraryErrorMessage() { return ''; },
    revokePreviewUrls() {},
    showResolvedImage() {},
    appendSlidePreview() {},
  });
  assert.equal(editor.isEnabled(), true);
  assert.equal(editor.isOpen(), false);
  assert.equal(byId('btn-edit-script').listeners.length, 1);
  assert.equal(byId('script-editor').listeners.length, 1);
});

test('a revision note is ignored until the editor is open, then it shows the existing conflict', async () => {
  const view = harness();
  view.editor.init({
    libraryFetch: async () => ({ ok: true, json: async () => ({ scripts: [], liveId: null }) }),
    rememberLibraryEntries() {},
    openLibrary() {},
    getLibraryEntries() { return []; },
    libraryCurrentTitle() { return ''; },
    readLibraryJson: async (response) => response.json(),
    libraryErrorMessage() { return ''; },
    revokePreviewUrls() {},
    showResolvedImage() {},
    appendSlidePreview() {},
  });
  await view.byId('btn-edit-script').listeners[0].fn();
  assert.equal(view.editor.isOpen(), true);
  assert.equal(view.byId('editor-conflict').hidden, true);
  view.live.revision = 'rev-newer';
  view.editor.noteScriptRevision();
  assert.equal(view.byId('editor-conflict').hidden, false);
  assert.match(view.byId('editor-conflict').textContent, /changed while this editor was open/);
});

test('separate editors do not share an open dialog or a revision note', async () => {
  const first = harness();
  const second = harness();
  const hooks = {
    libraryFetch: async () => ({ ok: true, json: async () => ({ scripts: [], liveId: null }) }),
    rememberLibraryEntries() {},
    openLibrary() {},
    getLibraryEntries() { return []; },
    libraryCurrentTitle() { return ''; },
    readLibraryJson: async (response) => response.json(),
    libraryErrorMessage() { return ''; },
    revokePreviewUrls() {},
    showResolvedImage() {},
    appendSlidePreview() {},
  };
  first.editor.init(hooks);
  await first.byId('btn-edit-script').listeners[0].fn();
  assert.equal(second.editor.isEnabled(), false);
  assert.equal(second.editor.isOpen(), false);
  second.editor.noteScriptRevision();
  assert.equal(first.editor.isOpen(), true);
  assert.equal(second.byId('editor-conflict').hidden, true);
});

test('library save and publish keep the draft, the revision, and the version id', async () => {
  const ids = {};
  const calls = [];
  const libraryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const versionA = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
  const versionB = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
  let uuid = 0;
  const versions = [versionA, versionB];
  const script = '# Opening\n[ADA]\nFIRST SPOKEN LINE\n';
  function byId(id) {
    if (!ids[id]) ids[id] = element();
    return ids[id];
  }
  const editor = createEditorView({
    document: { getElementById: byId, createElement: element },
    fetch(url, options) {
      calls.push({ url, options: options || null });
      if (url === '/script' && (!options || !options.method)) {
        return { ok: true, text: async () => script };
      }
      return {
        ok: false,
        status: 409,
        json: async () => ({
          ok: false,
          code: 'saved-not-live',
          saved: true,
          activated: false,
          rolledBack: false,
          versionId: versionA,
          error: 'The new version was saved and left in place. It is not live.',
        }),
      };
    },
    liveShow: {
      revision: 'rev-live',
      scriptId: 'live-1',
      getRevision() { return this.revision; },
      getLiveScriptId() { return this.scriptId; },
      setLiveScriptId() {},
      getLiveState() { return null; },
      getSlides() { return []; },
    },
    ScriptEditor,
    ScriptLibrary,
    ScriptFormat,
    crypto: { randomUUID: () => versions[uuid++] || versionB },
    storage: memoryStorage(),
    window: { setTimeout() { return 0; }, clearTimeout() {} },
  });
  const notices = [];
  editor.init({
    libraryFetch: async (url, options) => {
      calls.push({ url, options: options || null });
      if (options && options.method === 'PUT') {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            ok: false,
            partial: true,
            saved: { title: true, text: false },
            conflict: { field: 'text', code: 'conflict', error: 'The script text is newer.' },
            script: {
              id: libraryId,
              title: 'Updated title',
              revision: 'rev-old',
              generation: 4,
              versionId: versionA,
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          script: { id: libraryId, title: 'Old title', revision: 'rev-old', generation: 3, text: script },
        }),
      };
    },
    rememberLibraryEntries() {},
    openLibrary() {},
    getLibraryEntries() { return []; },
    libraryCurrentTitle() { return 'Live show'; },
    readLibraryJson: async (response) => response.json(),
    libraryErrorMessage(_response, body) { return body && body.error ? body.error : ''; },
    revokePreviewUrls() {},
    showResolvedImage() {},
    appendSlidePreview() {},
    showControllerNotice(message) { notices.push(message); },
  });
  await editor.open({ id: libraryId, title: 'Old title', revision: 'rev-old' });
  assert.match(byId('script-editor-title').textContent, /Updated title|Old title/);
  await byId('editor-save-library').listeners[0].fn();
  await byId('editor-save-library').listeners[0].fn();
  const saves = calls.filter((call) => call.options && call.options.method === 'PUT');
  assert.equal(saves.length, 2);
  assert.equal(saves[0].options.headers['X-Version-Id'], versionA);
  assert.equal(saves[1].options.headers['X-Version-Id'], versionA);
  assert.equal(JSON.parse(saves[0].options.body).expectedRevision, 'rev-old');
  assert.equal(JSON.parse(saves[1].options.body).expectedRevision, 'rev-old');
  assert.match(byId('editor-status').textContent, /title was saved/);
  assert.match(byId('editor-status').textContent, /script text was not saved/);
  assert.match(byId('editor-status').textContent, /not rolled back/);
  assert.match(byId('editor-status').textContent, /Saved generation 4/);
  assert.match(byId('script-editor-title').textContent, /Updated title/);
  assert.equal(byId('script-editor').open, true);
});

test('publish reports a saved version, then a stale live generation, without a second automatic save', async () => {
  const ids = {};
  const calls = [];
  const script = '# Opening\n[ADA]\nFIRST SPOKEN LINE\n';
  const versionA = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
  let posts = 0;
  function byId(id) {
    if (!ids[id]) ids[id] = element();
    return ids[id];
  }
  const editor = createEditorView({
    document: { getElementById: byId, createElement: element },
    fetch(url, options) {
      calls.push({ url, options: options || null });
      if (!options || options.method !== 'POST') return { ok: true, text: async () => script };
      posts += 1;
      if (posts === 1) {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            ok: false,
            code: 'saved-not-live',
            saved: true,
            activated: false,
            rolledBack: false,
            versionId: versionA,
          }),
        };
      }
      if (posts === 2) {
        return {
          ok: false,
          status: 409,
          json: async () => ({ ok: false, code: 'conflict', error: 'This saved copy changed after you opened it.' }),
        };
      }
      return {
        ok: false,
        status: 409,
        json: async () => ({ ok: false, code: 'stale-live', error: 'The live generation changed.' }),
      };
    },
    liveShow: {
      revision: 'rev-live',
      scriptId: 'live-1',
      getRevision() { return 'rev-live'; },
      getLiveScriptId() { return 'live-1'; },
      setLiveScriptId() {},
      getLiveState() { return null; },
      getSlides() { return []; },
    },
    ScriptEditor,
    ScriptLibrary,
    ScriptFormat,
    crypto: { randomUUID: () => versionA },
    storage: memoryStorage(),
    window: { setTimeout() { return 0; }, clearTimeout() {} },
  });
  editor.init({
    libraryFetch: async () => ({ ok: true, json: async () => ({ scripts: [], liveId: null }) }),
    rememberLibraryEntries() {},
    openLibrary() {},
    getLibraryEntries() { return []; },
    libraryCurrentTitle() { return ''; },
    readLibraryJson: async (response) => response.json(),
    libraryErrorMessage() { return ''; },
    revokePreviewUrls() {},
    showResolvedImage() {},
    appendSlidePreview() {},
  });
  await byId('btn-edit-script').listeners[0].fn();
  const before = calls.length;
  byId('editor-publish').listeners[0].fn();
  byId('editor-confirm-yes').listeners[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts, 1);
  assert.equal(calls.filter((call) => call.options && call.options.method === 'POST').length, 1);
  assert.equal(calls.at(-1).options.headers['X-Version-Id'], versionA);
  assert.match(byId('editor-confirm-status').textContent, /saved to the library/);
  assert.match(byId('editor-confirm-status').textContent, /did not go live/);
  assert.match(byId('editor-confirm-status').textContent, /second version was not created/);
  assert.match(byId('editor-confirm-status').textContent, new RegExp(versionA));
  assert.equal(byId('script-editor').open, true);
  byId('editor-confirm-yes').listeners[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts, 2);
  assert.equal(calls.at(-1).options.headers['X-Version-Id'], versionA);
  assert.match(byId('editor-confirm-status').textContent, /saved copy changed/);
  assert.equal(byId('editor-confirm-status').textContent.includes('not published'), false);
  byId('editor-confirm-yes').listeners[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts, 3);
  assert.match(byId('editor-confirm-status').textContent, /separate from a saved-copy conflict/);
  assert.equal(calls.length - before, 3);
});
