const test = require('node:test');
const assert = require('node:assert/strict');
const { createEditorView } = require('./public/editor-view');
const ScriptEditor = require('./script-editor-model');
const ScriptLibrary = require('./script-library-model');
const ScriptFormat = require('./script-format');

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
