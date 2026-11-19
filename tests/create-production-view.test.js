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
  el.querySelector = function () {
    let found = null;
    (function visit(node) {
      (node.children || []).forEach((child) => {
        if (found) return;
        if (child.type === 'text') found = child;
        else visit(child);
      });
    }(el));
    return found;
  };
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
    creationId: read('X-Creation-Request-Id'),
    assetId: read('X-Asset-Id'),
    json,
    body: options ? options.body : undefined,
  };
}

function file(name, text, type, lastModified) {
  return {
    name,
    type: type || 'text/plain',
    size: typeof text === 'string' ? text.length : 8,
    lastModified: lastModified || 1,
    text: async () => text,
  };
}

function idCrypto(ids) {
  let index = 0;
  return {
    randomUUID() {
      const id = ids[index] || ids[ids.length - 1];
      index += 1;
      return id;
    },
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
      const result = onFetch ? onFetch(call) : jsonResponse(200, { ok: true, scripts: [], liveId: LIVE });
      return Promise.resolve(result);
    },
    liveShow: live,
    ScriptEditor,
    ScriptLibrary,
    ScriptFormat,
    ...(Object.prototype.hasOwnProperty.call(settings, 'crypto') ? { crypto: settings.crypto } : {}),
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
  assert.equal(html.includes('id="library-new-title"'), false);
  assert.equal(html.includes('id="library-save-live"'), false);
  assert.equal(html.includes('id="library-add"'), false);
  assert.match(html, /id="library-create-open"/);
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
  assert.equal(ids['library-create'].hidden, true);
  assert.equal(ids['library-list'].hidden, false);
  assert.match(ids['library-status'].textContent, /not the live show/);
  assert.match(ids['library-status'].textContent, /No pictures were added/);
  assert.match(ids['library-status'].textContent, /images\/Title_Card\.jpeg/);
  assert.match(ids['library-status'].textContent, /does not change those lines/);

  await submit(ids);
  assert.equal(postsTo(calls, '/api/library').length, 1);

  const createdEdit = buttonLabeled(ids['library-list'], 'Edit');
  listen(createdEdit, 'click')();
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
  assert.equal(ids['library-create'].hidden, true);
  assert.match(ids['library-status'].textContent, /not the live show/);
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
  assert.equal(ids['library-create'].hidden, true);
  assert.match(ids['library-status'].textContent, /Uploaded to this production only: Title_Card\.jpeg, scene-a\.png, scene-b\.png/);
  assert.match(ids['library-status'].textContent, /not assigned to scenes/);
  assert.match(ids['library-status'].textContent, /images\/Title_Card\.jpeg/);
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
  assert.equal(ids['library-create'].hidden, true);
  assert.match(ids['library-status'].textContent, /Uploaded to this production only: good\.png, bad\.png/);
  assert.doesNotMatch(ids['library-status'].textContent, /Not uploaded/);
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
  assert.equal(ids['library-create'].hidden, true);
  assert.match(ids['library-status'].textContent, /not the live show/);
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('cancelling the system file window stays on the create form', async () => {
  const { ids, calls } = harness();
  ids['script-library'].open = true;
  openForm(ids);
  ids['library-create-name'].value = 'Hamlet';
  await choose(ids, 'library-create-script', [file('hamlet.txt', SCRIPT)]);

  ['library-create-script', 'library-create-card', 'library-create-scenes', 'library-image-file'].forEach((id) => {
    listen(ids[id], 'click')();
    listen(ids[id], 'cancel')({ stopPropagation() {}, preventDefault() {} });
    listen(ids['script-library'], 'cancel')({ preventDefault() {} });
    listen(ids['script-library'], 'cancel')({ preventDefault() {} });
    assert.equal(ids['library-create'].hidden, false, id);
    assert.equal(ids['script-library'].open, true, id);
  });
  assert.equal(ids['library-create-name'].value, 'Hamlet');
  assert.match(ids['library-create-review'].textContent, /hamlet\.txt/);
  assert.equal(calls.length, 0);

  await delay(350);
  listen(ids['script-library'], 'cancel')({ preventDefault() {} });
  assert.equal(ids['library-create'].hidden, true);
  assert.equal(ids['script-library'].open, true);
  assert.match(ids['library-status'].textContent, /Nothing was added/);
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
  assert.equal(ids['library-create'].hidden, true);
  assert.match(ids['library-status'].textContent, /not the live show/);
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

test('saving the current live script reports an existing match instead of a new copy', async () => {
  const existing = {
    id: LIVE,
    title: 'Stage copy',
    revision: 'abc',
    live: true,
  };
  const { ids } = harness((call) => {
    if (call.url === '/script') return jsonResponse(200, '# Scene\nHello from stage\n');
    if (call.method === 'POST' && call.url === '/api/library') {
      return jsonResponse(200, {
        ok: true,
        unchanged: true,
        tracked: true,
        activated: false,
        script: existing,
        liveId: LIVE,
      });
    }
    if (call.method === 'GET' && call.url === '/api/library') {
      return jsonResponse(200, { ok: true, liveId: LIVE, scripts: [existing] });
    }
    return jsonResponse(200, { ok: true, liveId: LIVE, scripts: [] });
  });
  ids['library-new-title'].value = 'Stage copy';
  await listen(ids['library-add'], 'submit')({ preventDefault() {} });
  assert.match(ids['library-status'].textContent, /already matches the live show/);
  assert.match(ids['library-status'].textContent, /second copy was not created/);
  assert.match(ids['library-status'].textContent, /live show was not changed/);
});

const CREATE_A = '11111111-1111-4111-8111-111111111111';
const CREATE_B = '22222222-2222-4222-8222-222222222222';
const ASSET_A = '33333333-3333-4333-8333-333333333333';
const ASSET_B = '44444444-4444-4444-8444-444444444444';
const ASSET_C = '55555555-5555-4555-8555-555555555555';
const ASSET_D = '66666666-6666-4666-8666-666666666666';

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

function formWith(root, type) {
  let found = null;
  walk(root, (el) => {
    if (!found && el.listeners && el.listeners.some((item) => item.type === type)) found = el;
  });
  return found;
}

test('create production reuses one request id until the content or the form changes', async () => {
  let created = null;
  const { ids, calls } = harness((call) => {
    if (call.method === 'POST' && call.url === '/api/library') {
      if (!created && call.json.title === 'Hamlet') return jsonResponse(500, { ok: false, error: 'lost' });
      created = createdScript(call);
      return jsonResponse(201, { ok: true, script: created, liveId: LIVE });
    }
    if (call.method === 'GET' && call.url === '/api/library') return jsonResponse(200, libraryList(created));
    return jsonResponse(200, { ok: true, liveId: LIVE, scripts: [] });
  }, { crypto: idCrypto([CREATE_A, CREATE_B, ASSET_A]) });
  openForm(ids);
  ids['library-create-name'].value = 'Hamlet';
  await choose(ids, 'library-create-script', [file('hamlet.txt', '# Scene\nHello\n')]);
  await submit(ids);
  await submit(ids);
  const firstTwo = postsTo(calls, '/api/library');
  assert.equal(firstTwo.length, 2);
  assert.equal(firstTwo[0].creationId, CREATE_A);
  assert.equal(firstTwo[1].creationId, CREATE_A);
  assert.equal(firstTwo[0].json.trackIfCurrent, false);
  assert.notEqual(firstTwo[0].creationId, NEW_ID);

  ids['library-create-name'].value = 'Macbeth';
  await submit(ids);
  const createdPosts = postsTo(calls, '/api/library');
  assert.equal(createdPosts.length, 3);
  assert.equal(createdPosts[2].creationId, CREATE_B);
  assert.equal(createdPosts[2].json.title, 'Macbeth');
  assert.equal(ids['library-create'].hidden, true);
  assert.match(ids['library-status'].textContent, /not the live show/);
  await submit(ids);
  assert.equal(postsTo(calls, '/api/library').length, 3);

  listen(ids['library-create-cancel'], 'click')();
  openForm(ids);
  ids['library-create-name'].value = 'Hamlet';
  await choose(ids, 'library-create-script', [file('hamlet.txt', '# Scene\nHello\n')]);
  await submit(ids);
  const again = postsTo(calls, '/api/library').at(-1);
  assert.equal(again.creationId, ASSET_A);
  assert.notEqual(again.creationId, CREATE_A);
});

test('a browser without request ids does not repeat a lost create', async () => {
  const { ids, calls } = harness((call) => {
    if (call.method === 'POST' && call.url === '/api/library') {
      return jsonResponse(500, { ok: false, error: 'lost' });
    }
    return jsonResponse(200, { ok: true, liveId: LIVE, scripts: [] });
  }, { crypto: null });
  openForm(ids);
  ids['library-create-name'].value = 'Hamlet';
  await choose(ids, 'library-create-script', [file('hamlet.txt', '# Scene\nHello\n')]);
  await submit(ids);
  await submit(ids);
  assert.equal(postsTo(calls, '/api/library').length, 1);
  assert.equal(postsTo(calls, '/api/library')[0].creationId, null);
  assert.match(ids['library-create-status'].textContent, /stable creation id/);
});

test('image retries keep their asset ids and a replaced file gets a new one', async () => {
  let created = null;
  let failCard = true;
  const { ids, calls, revoked } = harness((call) => {
    if (call.method === 'POST' && call.url === '/api/library') {
      created = createdScript(call);
      return jsonResponse(201, { ok: true, script: created, liveId: LIVE });
    }
    if (call.method === 'POST' && call.url === `/api/library/${NEW_ID}/assets`) {
      if (decodeURIComponent(call.assetName) === 'card.png' && failCard) {
        failCard = false;
        return jsonResponse(400, { ok: false, error: 'not stored' });
      }
      return jsonResponse(201, { ok: true, asset: { id: call.assetId, name: decodeURIComponent(call.assetName) } });
    }
    if (call.method === 'GET' && call.url === '/api/library') return jsonResponse(200, libraryList(created));
    return jsonResponse(200, { ok: true });
  }, { crypto: idCrypto([ASSET_A, ASSET_B, ASSET_C, CREATE_A, ASSET_D]) });
  openForm(ids);
  ids['library-create-name'].value = 'Hamlet';
  await choose(ids, 'library-create-script', [file('hamlet.txt', '# Scene\nHello\n')]);
  await choose(ids, 'library-create-card', [file('card.png', '', 'image/png')]);
  await choose(ids, 'library-create-scenes', [
    file('same.png', '', 'image/png', 10),
    file('same.png', '', 'image/png', 20),
  ]);
  await submit(ids);
  const uploads = calls.filter((call) => call.url.endsWith('/assets'));
  assert.deepEqual(uploads.map((call) => call.assetId), [ASSET_A, ASSET_B, ASSET_C]);
  assert.deepEqual(uploads.map((call) => decodeURIComponent(call.assetName)), ['card.png', 'same.png', 'same.png']);
  assert.equal(postsTo(calls, '/api/library').length, 1);
  assert.equal(postsTo(calls, '/api/library')[0].creationId, CREATE_A);
  assert.match(uploads[0].url, new RegExp(`/api/library/${NEW_ID}/assets`));

  await choose(ids, 'library-create-card', [file('card.png', '', 'image/png', 99)]);
  assert.deepEqual(revoked, ['blob:card.png']);
  await listen(ids['library-create-retry'], 'click')();
  const assets = calls.filter((call) => call.url.endsWith('/assets'));
  assert.equal(postsTo(calls, '/api/library').length, 1);
  assert.equal(assets.at(-1).assetId, ASSET_D);
  assert.notEqual(assets.at(-1).assetId, ASSET_A);
  assert.equal(assets.filter((call) => call.assetId === ASSET_B).length, 1);
});

test('manage images retries the same file and gives a new id to another file', async () => {
  const script = { id: NEW_ID, title: 'Hamlet', revision: 'rev-1', updatedAt: '2026-01-02T15:04:00.000Z' };
  let failOnce = true;
  const { library, ids, calls } = harness((call) => {
    if (call.url === '/api/library/access') return jsonResponse(200, { required: false });
    if (call.url === '/api/library') return jsonResponse(200, libraryList(script));
    if (call.url === `/api/library/${NEW_ID}/assets` && call.method === 'GET') {
      return jsonResponse(200, { ok: true, assets: [] });
    }
    if (call.url === `/api/library/${NEW_ID}/assets` && call.method === 'POST') {
      if (failOnce) {
        failOnce = false;
        return jsonResponse(400, { ok: false, error: 'not stored' });
      }
      return jsonResponse(201, { ok: true, asset: { id: call.assetId, name: 'card.png' } });
    }
    return jsonResponse(200, { ok: true });
  }, {
    crypto: idCrypto([ASSET_A, ASSET_B, ASSET_C]),
    storage: memoryStorage({ 'prompter-staff-token': 'stage-staff' }),
  });
  await library.open();
  listen(buttonLabeled(ids['library-list'], 'Manage Images'), 'click')();
  await Promise.resolve();
  ids['library-image-file'].files = [file('card.png', '', 'image/png', 5)];
  listen(ids['library-image-file'], 'change')();
  await settle();
  ids['library-image-file'].files = [file('card.png', '', 'image/png', 5)];
  listen(ids['library-image-file'], 'change')();
  await settle();
  ids['library-image-file'].files = [file('card.png', '', 'image/png', 6)];
  listen(ids['library-image-file'], 'change')();
  await settle();
  const uploads = calls.filter((call) => call.method === 'POST' && call.url.endsWith('/assets'));
  assert.deepEqual(uploads.map((call) => call.assetId), [ASSET_A, ASSET_A, ASSET_B]);
  assert.equal(uploads.every((call) => call.token === 'stage-staff'), true);
  assert.equal(uploads.every((call) => call.assetName === 'card.png'), true);
  assert.equal(postsTo(calls, '/api/library').length, 0);
});

test('save current live script explains a different saved head without changing it', async () => {
  const { ids, calls } = harness((call) => {
    if (call.url === '/script') return jsonResponse(200, '# Scene\nHello from stage\n');
    if (call.method === 'POST' && call.url === '/api/library') {
      return jsonResponse(409, {
        ok: false,
        code: 'saved-head-differs',
        error: 'short',
      });
    }
    return jsonResponse(200, { ok: true, liveId: LIVE, scripts: [] });
  });
  ids['library-new-title'].value = 'Stage copy';
  await listen(ids['library-add'], 'submit')({ preventDefault() {} });
  assert.equal(postsTo(calls, '/api/library').length, 1);
  assert.match(ids['library-status'].textContent, /saved copy and the live text are both still there/);
  assert.match(ids['library-status'].textContent, /neither copy was changed/);
  assert.equal(calls.some((call) => call.url.endsWith('/live')), false);
});

test('a partial title save refreshes the library title and names the failed script field', async () => {
  const script = { id: NEW_ID, title: 'Old title', revision: 'rev-old', updatedAt: '2026-01-02T15:04:00.000Z' };
  let renamed = false;
  const { library, ids, calls } = harness((call) => {
    if (call.url === '/api/library/access') return jsonResponse(200, { required: false });
    if (call.method === 'PUT' && call.url === `/api/library/${NEW_ID}`) {
      renamed = true;
      return jsonResponse(409, {
        ok: false,
        partial: true,
        code: 'partial',
        saved: { title: true, text: false },
        conflict: { field: 'text', code: 'conflict', error: 'The script text is newer.' },
        script: { id: NEW_ID, title: 'Updated title', revision: 'rev-old', generation: 4 },
      });
    }
    if (call.url === '/api/library') {
      return jsonResponse(200, libraryList(renamed
        ? { id: NEW_ID, title: 'Updated title', revision: 'rev-old' }
        : script));
    }
    return jsonResponse(200, { ok: true });
  });
  await library.open();
  listen(buttonLabeled(ids['library-list'], 'Rename'), 'click')();
  const form = formWith(ids['library-list'], 'submit');
  form.querySelector().value = 'Updated title';
  listen(form, 'submit')({ preventDefault() {} });
  await settle();
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 1);
  assert.equal(buttonLabeled(ids['library-list'], 'Updated title').textContent, 'Updated title');
  assert.match(ids['library-status'].textContent, /title was saved/);
  assert.match(ids['library-status'].textContent, /script text was not saved/);
  assert.match(ids['library-status'].textContent, /not rolled back/);
  assert.match(ids['library-status'].textContent, /Saved generation 4/);
  assert.match(ids['library-status'].textContent, /script text is newer/);
});

test('activation that is not ready explains image assignment and does not review another version', async () => {
  const script = { id: NEW_ID, title: 'Imported', revision: 'rev-old', updatedAt: '2026-01-02T15:04:00.000Z' };
  const { library, ids, calls } = harness((call) => {
    if (call.url === '/api/library/access') return jsonResponse(200, { required: false });
    if (call.url === `/api/library/${NEW_ID}/live`) {
      return jsonResponse(409, {
        ok: false,
        code: 'activation-not-ready',
        error: 'That version is not ready to go live.',
        sharedLegacyImages: true,
      });
    }
    if (call.url === '/api/library') return jsonResponse(200, libraryList(script));
    return jsonResponse(200, { ok: true });
  });
  await library.open();
  listen(buttonLabeled(ids['library-list'], 'Set as Live'), 'click')();
  listen(ids['library-confirm-yes'], 'click')();
  await settle();
  assert.equal(calls.filter((call) => call.url.endsWith('/live')).length, 1);
  assert.match(ids['library-confirm-status'].textContent, /cannot become live until its image references are resolved/);
  assert.match(ids['library-confirm-status'].textContent, /assign those images to the scene lines/);
  assert.match(ids['library-confirm-status'].textContent, /does not assign it to a scene/);
  assert.match(ids['library-confirm-status'].textContent, /different version was not selected/);
  assert.equal(ids['library-confirm-yes'].textContent, 'Set as Live');
  assert.doesNotMatch(ids['library-confirm-status'].textContent, /saved copy changed/);
});

test('version history lists committed versions and a missing endpoint stays off the live show', async () => {
  const head = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const older = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const script = { id: NEW_ID, title: 'Hamlet', revision: 'rev-1', updatedAt: '2026-01-02T15:04:00.000Z' };
  const { library, ids, calls } = harness((call) => {
    if (call.url === '/api/library/access') return jsonResponse(200, { required: false });
    if (call.url === '/api/library') return jsonResponse(200, libraryList(script));
    if (call.url === `/api/library/${NEW_ID}/versions` && call.method === 'GET') {
      return jsonResponse(200, {
        ok: true,
        productionId: NEW_ID,
        savedHeadVersionId: head,
        order: 'lineage',
        versions: [
          {
            versionId: older,
            parentVersionId: null,
            sequence: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            origin: 'original',
            committed: true,
            savedHead: false,
            live: true,
            previousLive: false,
            imageBytesImmutable: false,
            legacyImagePolicy: 'shared-images',
          },
          {
            versionId: head,
            parentVersionId: older,
            sequence: 2,
            createdAt: null,
            origin: 'edited',
            committed: true,
            savedHead: true,
            live: false,
            previousLive: true,
            imageBytesImmutable: true,
          },
        ],
        orphans: [{ versionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', complete: false, committed: false }],
        diagnostics: [{ versionId: null, code: 'corrupt-version', error: '/tmp/secret should stay hidden' }],
      });
    }
    return jsonResponse(200, { ok: true });
  });
  await library.open();
  listen(buttonLabeled(ids['library-list'], 'Version History'), 'click')();
  await settle();
  const parts = [];
  walk(ids['library-history-list'], (el) => { if (el.textContent) parts.push(el.textContent); });
  const list = parts.join('\n');
  assert.match(list, /Version 2/);
  assert.match(list, /Version 1/);
  assert.ok(list.indexOf('Version 2') < list.indexOf('Version 1'));
  assert.match(list, /Latest Saved/);
  assert.match(list, /Live Now/);
  assert.match(list, /Previous live/);
  assert.match(list, /Original/);
  assert.doesNotMatch(list, /Edited/);
  assert.match(list, /Original save time unavailable/);
  assert.match(list, /Technical details/);
  assert.match(list, new RegExp(head));
  assert.match(list, /shared image/i);
  assert.match(ids['library-history-warning'].textContent, /excluded from history/);
  assert.equal(list.includes('/tmp/secret'), false);
  assert.equal(list.includes('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'), false);
  listen(buttonLabeled(ids['library-history-list'], 'Restore as New Saved Version'), 'click')();
  assert.match(ids['library-confirm-heading'].textContent, /Restore this saved version/);
  const confirmText = [];
  walk(ids['library-confirm-body'], (el) => { if (el.textContent) confirmText.push(el.textContent); });
  assert.match(confirmText.join('\n'), /will not switch/);
  listen(ids['library-confirm-no'], 'click')();
  assert.equal(calls.some((call) => call.method === 'POST' && call.url.includes('/restore')), false);

  ids['library-history-list'].textContent = '';
  const missing = harness((call) => {
    if (call.url === '/api/library/access') return jsonResponse(200, { required: false });
    if (call.url === '/api/library') return jsonResponse(200, libraryList(script));
    if (call.url.endsWith('/versions')) return jsonResponse(404, 'Not found');
    return jsonResponse(200, { ok: true });
  });
  await missing.library.open();
  listen(buttonLabeled(missing.ids['library-list'], 'Version History'), 'click')();
  await settle();
  assert.match(missing.ids['library-history-status'].textContent, /not available on this library/);
  assert.doesNotMatch(missing.ids['library-history-status'].textContent, /corrupt/);
  assert.equal(missing.live.id, LIVE);
});

function labeledButtons(root, label) {
  const found = [];
  walk(root, (el) => {
    if (el.textContent === label) found.push(el);
  });
  return found;
}

test('delete asks before removing a production and leaves the live production alone', async () => {
  const liveScript = {
    id: LIVE,
    title: 'Opening',
    revision: 'rev-live',
    generation: 2,
    live: true,
    updatedAt: '2026-01-02T15:04:00.000Z',
  };
  const other = {
    id: NEW_ID,
    title: 'Hamlet',
    revision: 'rev-hamlet',
    generation: 4,
    live: false,
    updatedAt: '2026-01-02T15:04:00.000Z',
  };
  let scripts = [liveScript, other];
  let release = null;
  const { library, ids, calls, live } = harness((call) => {
    if (call.url === '/api/library/access') return jsonResponse(200, { required: false });
    if (call.method === 'DELETE' && call.url === `/api/library/${NEW_ID}`) {
      return new Promise((resolve) => {
        release = () => {
          scripts = [liveScript];
          resolve(jsonResponse(200, { ok: true, deleted: true, productionId: NEW_ID, title: 'Hamlet' }));
        };
      });
    }
    if (call.method === 'GET' && call.url === '/api/library') {
      return jsonResponse(200, { ok: true, liveId: LIVE, scripts });
    }
    return jsonResponse(200, { ok: true, liveId: LIVE, scripts });
  });
  await library.open();
  const deletes = labeledButtons(ids['library-list'], 'Delete');
  assert.equal(deletes.length, 2);
  const liveDelete = deletes.find((button) => button.attrs['aria-label'].includes('Opening'));
  const otherDelete = deletes.find((button) => button.attrs['aria-label'] === 'Delete Hamlet');
  assert.equal(liveDelete.disabled, true);
  assert.match(liveDelete.attrs['aria-label'], /Set another production as Live first/);
  listen(liveDelete, 'click')();
  assert.equal(ids['library-confirm'].hidden, true);
  assert.equal(calls.some((call) => call.method === 'DELETE'), false);

  listen(otherDelete, 'click')();
  assert.equal(ids['library-confirm'].hidden, false);
  assert.equal(ids['library-confirm-heading'].textContent, "Permanently delete 'Hamlet'?");
  const warning = [];
  walk(ids['library-confirm-body'], (el) => { if (el.textContent) warning.push(el.textContent); });
  assert.match(warning.join('\n'), /all saved versions/);
  assert.match(warning.join('\n'), /cannot be undone in the app/);
  assert.equal(ids['library-confirm-yes'].textContent, 'Delete Permanently');
  assert.equal(ids['library-confirm-no'].textContent, 'Cancel');
  assert.equal(ids['library-confirm-no'].focused, true);
  listen(ids['library-confirm-no'], 'click')();
  assert.equal(ids['library-confirm'].hidden, true);
  assert.equal(calls.some((call) => call.method === 'DELETE'), false);
  assert.equal(otherDelete.focused, true);
  assert.equal(labeledButtons(ids['library-list'], 'Delete').length, 2);

  listen(otherDelete, 'click')();
  const first = listen(ids['library-confirm-yes'], 'click')();
  const second = listen(ids['library-confirm-yes'], 'click')();
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1);
  const sent = calls.find((call) => call.method === 'DELETE');
  assert.equal(sent.url, `/api/library/${NEW_ID}`);
  assert.equal(sent.json.expectedGeneration, 4);
  assert.equal(sent.json.expectedRevision, 'rev-hamlet');
  assert.equal(ids['library-confirm-yes'].disabled, true);
  assert.equal(ids['library-confirm'].getAttribute('aria-busy'), 'true');
  release();
  await first;
  await second;
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1);
  assert.equal(ids['library-confirm'].hidden, true);
  assert.match(ids['library-status'].textContent, /Permanently deleted “Hamlet”/);
  assert.match(ids['library-status'].textContent, /cannot be undone in the app/);
  assert.match(ids['library-status'].textContent, /live show was not changed/);
  assert.equal(labeledButtons(ids['library-list'], 'Delete').length, 1);
  assert.equal(live.id, LIVE);
  assert.equal(ids['library-close'].focused, true);
});

test('a refused live delete stays in the dialog and does not remove the production', async () => {
  const script = {
    id: NEW_ID,
    title: 'Hamlet',
    revision: 'rev-hamlet',
    generation: 1,
    updatedAt: '2026-01-02T15:04:00.000Z',
  };
  const { library, ids, calls, live } = harness((call) => {
    if (call.url === '/api/library/access') return jsonResponse(200, { required: false });
    if (call.method === 'DELETE') {
      return jsonResponse(409, {
        ok: false,
        code: 'live-production',
        error: 'This production is live. Set another production as Live before deleting it. Nothing was deleted.',
      });
    }
    if (call.url === '/api/library') return jsonResponse(200, libraryList(script));
    return jsonResponse(200, { ok: true });
  });
  await library.open();
  listen(buttonLabeled(ids['library-list'], 'Delete'), 'click')();
  await listen(ids['library-confirm-yes'], 'click')();
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1);
  assert.equal(ids['library-confirm'].hidden, false);
  assert.match(ids['library-confirm-status'].textContent, /Set another production as Live/);
  assert.match(ids['library-confirm-status'].textContent, /Nothing was deleted/);
  assert.equal(buttonLabeled(ids['library-list'], 'Hamlet').textContent, 'Hamlet');
  assert.equal(live.id, LIVE);
});
