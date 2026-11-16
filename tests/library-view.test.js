const test = require('node:test');
const assert = require('node:assert/strict');
const { createLibraryView } = require('../public/library-view');
const ScriptEditor = require('../script-editor-model');

function memoryStorage(initial) {
  const values = new Map(Object.entries(initial || {}));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function element() {
  return {
    open: false,
    hidden: true,
    inert: false,
    disabled: false,
    textContent: '',
    value: '',
    dataset: {},
    classList: { add() {}, remove() {} },
    listeners: [],
    addEventListener(type, fn) { this.listeners.push({ type, fn }); },
    setAttribute() {},
    getAttribute() { return null; },
    replaceChildren() {},
    append() {},
    focus() {},
    showModal() { this.open = true; },
    close() { this.open = false; },
  };
}

function harness(storage) {
  const ids = {};
  const calls = [];
  const live = {
    id: 'live-1',
    getLiveScriptId() { return this.id; },
    setLiveScriptId(id) { this.id = id; },
  };
  const library = createLibraryView({
    document: {
      getElementById(id) {
        if (!ids[id]) ids[id] = element();
        return ids[id];
      },
      createElement: element,
    },
    fetch(url, options) {
      const headers = options && options.headers;
      calls.push({
        url,
        token: headers && typeof headers.get === 'function' ? headers.get('X-Staff-Token') : '',
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, required: false, scripts: [], liveId: null }),
        text: async () => '',
      });
    },
    liveShow: live,
    ScriptEditor,
    sessionStorage: storage || memoryStorage(),
  });
  return { library, ids, calls, live };
}

function hooks(editorOpen) {
  return {
    openEditor() {},
    editorIsOpen() { return editorOpen; },
    showControllerNotice() {},
    revokePreviewUrls() {},
    showResolvedImage() {},
    appendSlidePreview() {},
  };
}

test('library controls stay idle until the controller initializes them', () => {
  const { library, ids, calls } = harness();
  assert.equal(library.isEnabled(), false);
  assert.equal(library.isOpen(), false);
  library.open();
  assert.equal(calls.length, 0);
  library.init(hooks(false));
  assert.equal(library.isEnabled(), true);
  assert.equal(library.isOpen(), false);
  assert.equal(ids['btn-script-library'].listeners.length, 1);
  library.init(hooks(false));
  assert.equal(ids['btn-script-library'].listeners.length, 1);
});

test('library fetch sends the stored staff code and keeps an explicit one', async () => {
  const { library, calls } = harness(memoryStorage({ 'prompter-staff-token': 'stage-staff' }));
  await library.fetch('/api/library');
  await library.fetch('/api/library', { headers: { 'X-Staff-Token': 'already-set' } });
  assert.equal(calls[0].token, 'stage-staff');
  assert.equal(calls[1].token, 'already-set');
});

test('the current title follows the live production, then the library cache', () => {
  const { library, live } = harness();
  library.remember([
    { id: 'live-1', title: 'Hamlet' },
    { id: 'other', title: 'Macbeth' },
  ], 'other');
  assert.equal(library.currentTitle(), 'Hamlet');
  assert.equal(library.getEntries()[1].title, 'Macbeth');
  live.id = null;
  assert.equal(library.currentTitle(), 'Macbeth');
});

test('separate libraries do not share entries or an open dialog', async () => {
  const first = harness();
  const second = harness();
  first.library.init(hooks(true));
  first.library.remember([{ id: 'live-1', title: 'Hamlet' }], 'live-1');
  await first.library.open();
  assert.equal(first.calls.length, 0);
  assert.equal(first.library.isOpen(), false);
  assert.equal(second.library.isEnabled(), false);
  assert.equal(second.library.getEntries().length, 0);
  assert.equal(second.library.currentTitle(), '');
});
