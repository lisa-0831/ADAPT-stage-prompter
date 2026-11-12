const test = require('node:test');
const assert = require('node:assert/strict');
const { createReplaceScript } = require('./public/replace-script');

function classList() {
  const names = new Set();
  return {
    toggle(name) {
      if (names.has(name)) {
        names.delete(name);
        return false;
      }
      names.add(name);
      return true;
    },
    contains(name) {
      return names.has(name);
    },
    remove(name) {
      names.delete(name);
    },
  };
}

function elements() {
  return {
    toggle: { onclick: null },
    cancel: { onclick: null },
    submit: { onclick: null },
    area: { classList: classList() },
    textarea: { value: '' },
  };
}

function harness() {
  const calls = [];
  const alerts = [];
  const ui = elements();
  let nextResponse = { ok: true, text: 'CURRENT SCRIPT' };
  const workflow = createReplaceScript({
    fetch(url, options) {
      calls.push({ url, options: options || null });
      const response = nextResponse;
      return Promise.resolve({
        ok: response.ok,
        text() { return Promise.resolve(response.text); },
      });
    },
    alert(message) { alerts.push(message); },
  });
  return {
    workflow,
    calls,
    alerts,
    ui,
    respond(response) { nextResponse = response; },
  };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('replace controls stay idle until the controller initializes them', async () => {
  const { workflow, calls, ui } = harness();
  assert.equal(ui.toggle.onclick, null);
  workflow.init({ elements: ui });
  assert.equal(typeof ui.toggle.onclick, 'function');
  assert.equal(calls.length, 0);
});

test('opening loads the current script, and closing does not submit it', async () => {
  const { workflow, calls, ui } = harness();
  workflow.init({ elements: ui });
  ui.toggle.onclick();
  await flush();
  assert.equal(ui.area.classList.contains('open'), true);
  assert.equal(ui.textarea.value, 'CURRENT SCRIPT');
  assert.deepEqual(calls, [{ url: '/script', options: null }]);

  ui.toggle.onclick();
  await flush();
  assert.equal(ui.area.classList.contains('open'), false);
  assert.equal(calls.length, 1);

  ui.toggle.onclick();
  await flush();
  ui.cancel.onclick();
  assert.equal(ui.area.classList.contains('open'), false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options, null);
});

test('blank text is not posted, and a real replacement keeps the trimmed body', async () => {
  const { workflow, calls, ui } = harness();
  workflow.init({ elements: ui });

  ui.textarea.value = ' \n ';
  await ui.submit.onclick();
  assert.equal(calls.length, 0);
  assert.equal(ui.area.classList.contains('open'), false);

  ui.area.classList.toggle('open');
  ui.textarea.value = '  # Scene\n[ADA]\nHELLO  ';
  await ui.submit.onclick();
  assert.deepEqual(calls, [{
    url: '/script',
    options: {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '# Scene\n[ADA]\nHELLO',
    },
  }]);
  assert.equal(ui.area.classList.contains('open'), false);
});

test('a failed upload shows the existing alert and leaves the panel open', async () => {
  const { workflow, calls, alerts, ui, respond } = harness();
  workflow.init({ elements: ui });
  ui.area.classList.toggle('open');
  ui.textarea.value = '# Scene\nLine';
  respond({ ok: false, text: '' });

  await ui.submit.onclick();
  assert.deepEqual(alerts, ['Upload failed — check server.']);
  assert.equal(ui.area.classList.contains('open'), true);
  assert.equal(calls[0].options.body, '# Scene\nLine');
});

test('separate replace panels do not share a request or a textarea', async () => {
  const first = harness();
  const second = harness();
  first.workflow.init({ elements: first.ui });
  second.workflow.init({ elements: second.ui });
  first.ui.textarea.value = 'FIRST';
  second.ui.textarea.value = 'SECOND';
  await first.ui.submit.onclick();
  assert.equal(first.calls[0].options.body, 'FIRST');
  assert.equal(second.calls.length, 0);
  assert.equal(second.ui.textarea.value, 'SECOND');
});
