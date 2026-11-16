const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLibraryView } = require('../public/library-view');
const ScriptEditor = require('../script-editor-model');
const ScriptLibrary = require('../script-library-model');
const ScriptFormat = require('../script-format');

const LIVE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NEW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SCRIPT = '# New Room\n@image: images/Title_Card.jpeg\n[ADA]\nCREATED LINE\n';

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

function formElement() {
  const el = element();
  el.children = [];
  el.files = [];
  el.attrs = {};
  el.className = '';
  el.focused = false;
  el.setAttribute = function (name, value) { this.attrs[name] = String(value); };
  el.getAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  };
  el.removeAttribute = function (name) { delete this.attrs[name]; };
  el.append = function (...nodes) { this.children.push(...nodes); };
  el.replaceChildren = function (...nodes) { this.children = nodes; };
  el.focus = function () { this.focused = true; };
  return el;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function capture(url, options) {
  const headers = options && options.headers;
  const read = (name) => (headers && typeof headers.get === 'function' ? headers.get(name) : '');
  let json = null;
  if (options && typeof options.body === 'string') {
    try { json = JSON.parse(options.body); } catch (err) { json = null; }
  }
  return {
    url: String(url),
    method: (options && options.method) || 'GET',
    token: read('X-Staff-Token'),
    assetName: read('X-Asset-Name'),
    json,
    body: options ? options.body : undefined,
  };
}

function file(name, text, type) {
  return {
    name,
    type: type || 'text/plain',
    size: typeof text === 'string' ? text.length : 8,
    text: async () => text,
  };
}

function harness(onFetch, extras) {
  const ids = {};
  const calls = [];
  const revoked = [];
  const opened = [];
  const settings = extras || {};
  const live = {
    id: LIVE,
    setIds: [],
    getLiveScriptId() { return this.id; },
    setLiveScriptId(id) { this.setIds.push(id); this.id = id; },
  };
  const library = createLibraryView({
    document: {
      getElementById(id) {
        if (!ids[id]) ids[id] = formElement();
        return ids[id];
      },
      createElement: formElement,
    },
    fetch(url, options) {
      const call = capture(url, options);
      calls.push(call);
      if (onFetch) return onFetch(call);
      return jsonResponse(200, { ok: true, scripts: [], liveId: LIVE });
    },
    liveShow: live,
    ScriptEditor,
    ScriptLibrary,
    ScriptFormat,
    sessionStorage: settings.storage || memoryStorage(settings.token ? { 'prompter-staff-token': settings.token } : {}),
    objectUrls: {
      createObjectURL(blob) { return `blob:${blob.name}`; },
      revokeObjectURL(url) { revoked.push(url); },
    },
  });
  library.init({
    openEditor(entry) { opened.push(entry); },
    editorIsOpen() { return false; },
    showControllerNotice() {},
    revokePreviewUrls() {},
    showResolvedImage() {},
    appendSlidePreview() {},
  });
  return { library, ids, calls, live, opened, revoked };
}

function listen(el, type) {
  const found = el.listeners.filter((item) => item.type === type);
  assert.ok(found.length, `missing ${type} listener`);
  return found[found.length - 1].fn;
}

function openForm(ids) {
  listen(ids['library-create-open'], 'click')();
}

async function choose(ids, elementId, files) {
  ids[elementId].files = files;
  await listen(ids[elementId], 'change')();
}

function submit(ids) {
  return listen(ids['library-create'], 'submit')({ preventDefault() {} });
}

function postsTo(calls, url, method) {
  return calls.filter((call) => call.method === (method || 'POST') && call.url === url);
}

function libraryList(script) {
  return {
    ok: true,
    liveId: LIVE,
    scripts: script ? [{
      id: script.id,
      title: script.title,
      revision: script.revision,
      updatedAt: '2026-01-02T15:04:00.000Z',
    }] : [],
  };
}

function createdScript(call) {
  return {
    id: NEW_ID,
    title: call.json.title,
    revision: 'rev-1',
  };
}

function walk(el, visit) {
  visit(el);
  (el.children || []).forEach((child) => walk(child, visit));
}

function buttonLabeled(root, label) {
  let found = null;
  walk(root, (el) => {
    if (el.textContent === label) found = el;
  });
  return found;
}

test('the create production form names its fields and actions', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'client.html'), 'utf8');
  assert.match(html, /for="library-create-name"/);
  assert.match(html, /for="library-create-script"/);
  assert.match(html, /for="library-create-card"/);
  assert.match(html, /for="library-create-scenes"/);
  assert.match(html, /id="library-create-submit"/);
  assert.match(html, /id="library-create-cancel"/);
  assert.match(html, /id="library-create-status"/);
  assert.match(html, /aria-labelledby="library-create-heading"/);
  assert.equal(html.includes('id="library-file"'), false);
});

test('choosing a script, a title card, or scene images sends no request', async () => {
  const { ids, calls } = harness();
  openForm(ids);
  await choose(ids, 'library-create-script', [file('hamlet.txt', SCRIPT)]);
  await choose(ids, 'library-create-card', [file('Title_Card.jpeg', '', 'image/png')]);
  await choose(ids, 'library-create-scenes', [
    file('scene-a.png', '', 'image/png'),
    file('scene-b.png', '', 'image/png'),
  ]);
  assert.equal(calls.length, 0);
  assert.match(ids['library-create-review'].textContent, /hamlet\.txt/);
  assert.match(ids['library-create-review'].textContent, /Title_Card\.jpeg/);
  assert.match(ids['library-create-review'].textContent, /scene-a\.png/);
  assert.match(ids['library-create-status'].textContent, /not been uploaded/);
});

test('cancel before create sends no request and revokes preview urls', async () => {
  const { ids, calls, revoked } = harness();
  openForm(ids);
  await choose(ids, 'library-create-script', [file('hamlet.txt', SCRIPT)]);
  await choose(ids, 'library-create-card', [file('Title_Card.jpeg', '', 'image/png')]);
  await choose(ids, 'library-create-scenes', [file('scene-a.png', '', 'image/png')]);
  assert.equal(ids['library-create-card-preview'].src, 'blob:Title_Card.jpeg');
  assert.equal(ids['library-create-card-preview'].alt, 'Preview of Title_Card.jpeg');
  assert.equal(ids['library-create-scene-list'].children.length, 1);
  assert.equal(ids['library-create-scene-list'].children[0].children[0].src, 'blob:scene-a.png');

  listen(ids['library-create-scene-list'].children[0].children[2], 'click')();
  assert.equal(ids['library-create-scene-list'].children.length, 0);
  assert.deepEqual(revoked, ['blob:scene-a.png']);
  assert.doesNotMatch(ids['library-create-review'].textContent, /scene-a\.png/);

  listen(ids['library-create-card-clear'], 'click')();
  listen(ids['library-create-cancel'], 'click')();
  assert.equal(ids['library-create'].hidden, true);
  assert.equal(ids['library-create-open'].hidden, false);
  assert.match(ids['library-status'].textContent, /Nothing was added/);
  assert.equal(calls.length, 0);
  assert.deepEqual(revoked, ['blob:scene-a.png', 'blob:Title_Card.jpeg']);
});

test('create production requires a title and a readable script', async () => {
  const { ids, calls } = harness();
  openForm(ids);
  await submit(ids);
  assert.match(ids['library-create-status'].textContent, /title/i);
  assert.equal(ids['library-create-status'].getAttribute('role'), 'alert');
  assert.equal(ids['library-create-name'].focused, true);

  ids['library-create-name'].value = 'Hamlet';
  await submit(ids);
  assert.match(ids['library-create-status'].textContent, /script file/i);

  await choose(ids, 'library-create-script', [file('empty.txt', '   ')]);
  await submit(ids);
  assert.match(ids['library-create-status'].textContent, /empty/i);
  assert.equal(calls.length, 0);
});

test('an explicit submit creates one production and does not change live', async () => {
  let created = null;
  const { ids, calls, live, opened } = harness((call) => {
    if (call.method === 'POST' && call.url === '/api/library') {
      created = createdScript(call);
      return jsonResponse(201, { ok: true, script: created, liveId: LIVE });
    }
    if (call.method === 'GET' && call.url === '/api/library') return jsonResponse(200, libraryList(created));
    return jsonResponse(200, libraryList(created));
  });
  openForm(ids);
  ids['library-create-name'].value = 'Hamlet';
  await choose(ids, 'library-create-script', [file('hamlet.txt', SCRIPT)]);
  await submit(ids);

  const createdPosts = postsTo(calls, '/api/library');
  assert.equal(createdPosts.length, 1);
  assert.equal(createdPosts[0].json.trackIfCurrent, false);
  assert.equal(createdPosts[0].json.text, SCRIPT);
  assert.equal(calls.some((call) => call.url.endsWith('/live')), false);
  assert.equal(calls.some((call) => call.url === '/script'), false);
  assert.equal(live.id, LIVE);
  assert.equal(live.setIds.includes(NEW_ID), false);
  assert.match(ids['library-create-status'].textContent, /not the live show/);
  assert.match(ids['library-create-status'].textContent, /No pictures were added/);
  assert.match(ids['library-create-status'].textContent, /images\/Title_Card\.jpeg/);
  assert.match(ids['library-create-status'].textContent, /does not change those lines/);

  await submit(ids);
  assert.equal(postsTo(calls, '/api/library').length, 1);

  listen(ids['library-create-edit'], 'click')();
  assert.equal(opened[0].id, NEW_ID);
  assert.equal(opened[0].title, 'Hamlet');
  assert.equal(ids['library-create'].hidden, true);
  const listed = buttonLabeled(ids['library-list'], 'Set as Live');
  assert.ok(listed);
  listen(listed, 'click')();
  assert.equal(ids['library-confirm'].hidden, false);
  assert.equal(calls.some((call) => call.url.endsWith('/live')), false);
  listen(ids['library-confirm-no'], 'click')();
  assert.equal(ids['library-confirm'].hidden, true);
  const edit = buttonLabeled(ids['library-list'], 'Edit');
  listen(edit, 'click')();
  assert.equal(opened[1].id, NEW_ID);
});

test('repeated create clicks send one production request', async () => {
  let release = null;
  let created = null;
  const { ids, calls } = harness((call) => {
    if (call.method === 'POST' && call.url === '/api/library') {
      created = createdScript(call);
      return new Promise((resolve) => {
        release = () => resolve(jsonResponse(201, { ok: true, script: created, liveId: LIVE }));
      });
    }
    if (call.method === 'GET' && call.url === '/api/library') return jsonResponse(200, libraryList(created));
    return jsonResponse(200, { ok: true });
  });
  openForm(ids);
  ids['library-create-name'].value = 'Hamlet';
  await choose(ids, 'library-create-script', [file('hamlet.txt', '# Scene\nHello\n')]);
  const first = submit(ids);
  const second = submit(ids);
  assert.equal(postsTo(calls, '/api/library').length, 1);
  assert.equal(ids['library-create-submit'].disabled, true);
  assert.equal(ids['library-create'].getAttribute('aria-busy'), 'true');
  assert.equal(ids['library-create-cancel'].disabled, true);
  release();
  await first;
  await second;
  assert.equal(postsTo(calls, '/api/library').length, 1);
  assert.match(ids['library-create-status'].textContent, /not the live show/);
});

test('selected images are uploaded only to the new production', async () => {
  let created = null;
  const { ids, calls, live } = harness((call) => {
    if (call.method === 'POST' && call.url === '/api/library') {
      created = createdScript(call);
      return jsonResponse(201, { ok: true, script: created, liveId: LIVE });
    }
    if (call.method === 'POST' && call.url === `/api/library/${NEW_ID}/assets`) {
      return jsonResponse(201, {
        ok: true,
        asset: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: decodeURIComponent(call.assetName) },
      });
    }
    if (call.method === 'GET' && call.url === '/api/library') return jsonResponse(200, libraryList(created));
    return jsonResponse(500, { ok: false, error: 'unexpected request' });
  });
  openForm(ids);
  ids['library-create-name'].value = 'Hamlet';
  await choose(ids, 'library-create-script', [file('hamlet.txt', SCRIPT)]);
  await choose(ids, 'library-create-card', [file('Title_Card.jpeg', '', 'image/png')]);
  await choose(ids, 'library-create-scenes', [
    file('scene-a.png', '', 'image/png'),
    file('scene-b.png', '', 'image/png'),
  ]);
  await submit(ids);

  const uploads = calls.filter((call) => call.method === 'POST' && call.url.endsWith('/assets'));
  assert.deepEqual(uploads.map((call) => call.url), [
    `/api/library/${NEW_ID}/assets`,
    `/api/library/${NEW_ID}/assets`,
    `/api/library/${NEW_ID}/assets`,
  ]);
  assert.deepEqual(uploads.map((call) => decodeURIComponent(call.assetName)), [
    'Title_Card.jpeg',
    'scene-a.png',
    'scene-b.png',
  ]);
  assert.equal(uploads.some((call) => call.url.includes(LIVE)), false);
  assert.equal(live.id, LIVE);
  assert.match(ids['library-create-status'].textContent, /Uploaded to this production only: Title_Card\.jpeg, scene-a\.png, scene-b\.png/);
  assert.match(ids['library-create-status'].textContent, /not assigned to scenes/);
  assert.match(ids['library-create-status'].textContent, /images\/Title_Card\.jpeg/);
  assert.equal(postsTo(calls, '/api/library').length, 1);
  assert.equal(postsTo(calls, '/api/library')[0].json.text, SCRIPT);
});

test('a failed image upload is reported and retried without another production', async () => {
  let created = null;
  let failBad = true;
  const { ids, calls } = harness((call) => {
    if (call.method === 'POST' && call.url === '/api/library') {
      created = createdScript(call);
      return jsonResponse(201, { ok: true, script: created, liveId: LIVE });
    }
    if (call.method === 'POST' && call.url === `/api/library/${NEW_ID}/assets`) {
      const name = decodeURIComponent(call.assetName);
      if (name === 'bad.png' && failBad) {
        failBad = false;
        return jsonResponse(400, { ok: false, error: 'That file is not a JPEG, PNG, or WebP image.' });
      }
      return jsonResponse(201, {
        ok: true,
        asset: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name },
      });
    }
    if (call.method === 'GET' && call.url === '/api/library') return jsonResponse(200, libraryList(created));
    return jsonResponse(500, { ok: false, error: 'unexpected request' });
  });
  openForm(ids);
  ids['library-create-name'].value = 'Hamlet';
  await choose(ids, 'library-create-script', [file('hamlet.txt', '# Scene\nHello\n')]);
  await choose(ids, 'library-create-card', [file('good.png', '', 'image/png')]);
  await choose(ids, 'library-create-scenes', [file('bad.png', '', 'image/png')]);
  await submit(ids);

  assert.equal(postsTo(calls, '/api/library').length, 1);
  assert.match(ids['library-create-status'].textContent, /Created “Hamlet”/);
  assert.match(ids['library-create-status'].textContent, /Not uploaded: bad\.png/);
  assert.match(ids['library-create-status'].textContent, /not an all-or-nothing save/);
  assert.equal(ids['library-create-status'].getAttribute('role'), 'alert');
  assert.equal(ids['library-create-retry'].hidden, false);
  assert.equal(ids['library-create'].hidden, false);

  await listen(ids['library-create-retry'], 'click')();
  assert.equal(postsTo(calls, '/api/library').length, 1);
  const assetNames = calls
    .filter((call) => call.url.endsWith('/assets'))
    .map((call) => decodeURIComponent(call.assetName));
  assert.deepEqual(assetNames, ['good.png', 'bad.png', 'bad.png']);
  assert.match(ids['library-create-status'].textContent, /Uploaded to this production only: good\.png, bad\.png/);
  assert.doesNotMatch(ids['library-create-status'].textContent, /Not uploaded/);
  assert.equal(ids['library-create-retry'].hidden, true);
});

test('a rejected staff code does not create a production, and the draft can be submitted once', async () => {
  const storage = memoryStorage({ 'prompter-staff-token': 'stage-staff' });
  let attempts = 0;
  let created = null;
  const { ids, calls } = harness((call) => {
    if (call.method === 'POST' && call.url === '/api/library') {
      attempts += 1;
      if (attempts === 1) return jsonResponse(401, { ok: false, error: 'nope' });
      created = createdScript(call);
      return jsonResponse(201, { ok: true, script: created, liveId: LIVE });
    }
    if (call.method === 'GET' && call.url === '/api/library') return jsonResponse(200, libraryList(created));
    return jsonResponse(200, { ok: true, liveId: LIVE, scripts: [] });
  }, { storage });
  openForm(ids);
  ids['library-create-name'].value = 'Hamlet';
  await choose(ids, 'library-create-script', [file('hamlet.txt', '# Scene\nHello\n')]);
  await submit(ids);

  assert.equal(attempts, 1);
  assert.equal(storage.getItem('prompter-staff-token'), null);
  assert.equal(ids['library-access'].hidden, false);
  assert.equal(ids['library-create'].hidden, true);
  assert.match(ids['library-create-status'].textContent, /staff access code was not accepted/);
  assert.equal(calls.some((call) => call.url.endsWith('/assets')), false);

  await submit(ids);
  await submit(ids);
  assert.equal(attempts, 2);
  assert.equal(postsTo(calls, '/api/library').length, 2);
  assert.equal(postsTo(calls, '/api/library')[1].json.trackIfCurrent, false);
  assert.match(ids['library-create-status'].textContent, /not the live show/);
});

test('escape cancels an unsent form and stays in the library', async () => {
  const { ids, calls } = harness();
  ids['script-library'].open = true;
  openForm(ids);
  ids['library-create-name'].value = 'Hamlet';
  await choose(ids, 'library-create-script', [file('hamlet.txt', SCRIPT)]);
  listen(ids['script-library'], 'cancel')({ preventDefault() {} });
  assert.equal(calls.length, 0);
  assert.equal(ids['library-create'].hidden, true);
  assert.equal(ids['script-library'].open, true);
  assert.match(ids['library-status'].textContent, /Nothing was added/);
  assert.equal(ids['library-create-open'].focused, true);

  listen(ids['script-library'], 'cancel')({ preventDefault() {} });
  assert.equal(ids['script-library'].open, false);
  assert.equal(calls.length, 0);
});

test('escape during creation does not drop the in-flight production', async () => {
  let release = null;
  let created = null;
  const { ids, calls } = harness((call) => {
    if (call.method === 'POST' && call.url === '/api/library') {
      created = createdScript(call);
      return new Promise((resolve) => {
        release = () => resolve(jsonResponse(201, { ok: true, script: created, liveId: LIVE }));
      });
    }
    if (call.method === 'GET' && call.url === '/api/library') return jsonResponse(200, libraryList(created));
    return jsonResponse(200, { ok: true });
  });
  ids['script-library'].open = true;
  openForm(ids);
  ids['library-create-name'].value = 'Hamlet';
  await choose(ids, 'library-create-script', [file('hamlet.txt', '# Scene\nHello\n')]);
  const pending = submit(ids);
  listen(ids['script-library'], 'cancel')({ preventDefault() {} });
  assert.equal(ids['script-library'].open, true);
  assert.equal(ids['library-create'].hidden, false);
  assert.equal(postsTo(calls, '/api/library').length, 1);
  release();
  await pending;
  assert.equal(postsTo(calls, '/api/library').length, 1);
  assert.match(ids['library-create-status'].textContent, /not the live show/);
});

test('saving the current live script still saves that script and does not use the create form', async () => {
  let created = null;
  const { ids, calls } = harness((call) => {
    if (call.url === '/script') return jsonResponse(200, '# Scene\nHello from stage\n');
    if (call.method === 'POST' && call.url === '/api/library') {
      created = createdScript(call);
      return jsonResponse(201, { ok: true, script: created, liveId: LIVE });
    }
    if (call.method === 'GET' && call.url === '/api/library') return jsonResponse(200, libraryList(created));
    return jsonResponse(200, { ok: true, liveId: LIVE, scripts: [] });
  });
  ids['library-new-title'].value = 'Stage copy';
  await listen(ids['library-add'], 'submit')({ preventDefault() {} });
  const post = postsTo(calls, '/api/library')[0];
  assert.equal(post.json.trackIfCurrent, true);
  assert.equal(post.json.text, '# Scene\nHello from stage\n');
  assert.equal(ids['library-create'].hidden, true);
  assert.match(ids['library-status'].textContent, /Stage copy/);
});
