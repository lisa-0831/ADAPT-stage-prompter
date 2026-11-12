const test = require('node:test');
const assert = require('node:assert/strict');
const { createExitConfirmation } = require('./public/exit-confirmation');

function classList() {
  const names = new Set();
  return {
    add(name) { names.add(name); },
    remove(name) { names.delete(name); },
    contains(name) { return names.has(name); },
  };
}

function controls() {
  return {
    exit: { onclick: null },
    stay: { onclick: null },
    confirm: { onclick: null },
    guard: { classList: classList() },
  };
}

function target() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, fn) { listeners.push({ type, fn }); },
  };
}

function key(name) {
  return {
    key: name,
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
}

function harness() {
  const ui = controls();
  const windowTarget = target();
  const page = { href: 'http://show.example/' };
  let allowed = true;
  const exit = createExitConfirmation({ location: page, target: windowTarget });
  return {
    exit,
    ui,
    windowTarget,
    page,
    allow(value) { allowed = value; },
    canHandleEscape() { return allowed; },
  };
}

test('exit controls stay idle until the controller initializes them', () => {
  const { exit, ui, windowTarget } = harness();
  assert.equal(exit.isEnabled(), false);
  exit.init({ elements: ui, target: windowTarget });
  assert.equal(exit.isEnabled(), true);
  assert.equal(typeof ui.exit.onclick, 'function');
  assert.equal(windowTarget.listeners.length, 1);
  assert.equal(windowTarget.listeners[0].type, 'keydown');
  assert.equal(ui.guard.classList.contains('show'), false);
});

test('opening, staying, and escape use one confirmation step', () => {
  const view = harness();
  view.exit.init({
    elements: view.ui,
    target: view.windowTarget,
    canHandleEscape: view.canHandleEscape,
  });

  view.ui.exit.onclick();
  assert.equal(view.ui.guard.classList.contains('show'), true);
  view.ui.stay.onclick();
  assert.equal(view.ui.guard.classList.contains('show'), false);

  const openEscape = key('Escape');
  view.windowTarget.listeners[0].fn(openEscape);
  assert.equal(openEscape.prevented, true);
  assert.equal(view.ui.guard.classList.contains('show'), true);

  const closeEscape = key('Escape');
  view.windowTarget.listeners[0].fn(closeEscape);
  assert.equal(closeEscape.prevented, true);
  assert.equal(view.ui.guard.classList.contains('show'), false);

  const arrow = key('ArrowRight');
  view.windowTarget.listeners[0].fn(arrow);
  assert.equal(arrow.prevented, false);
  assert.equal(view.ui.guard.classList.contains('show'), false);
});

test('an open editor or library keeps escape away from the exit guard', () => {
  const view = harness();
  view.exit.init({
    elements: view.ui,
    target: view.windowTarget,
    canHandleEscape: view.canHandleEscape,
  });
  view.allow(false);
  const escape = key('Escape');
  view.windowTarget.listeners[0].fn(escape);
  assert.equal(escape.prevented, false);
  assert.equal(view.ui.guard.classList.contains('show'), false);

  view.ui.exit.onclick();
  view.windowTarget.listeners[0].fn(key('Escape'));
  assert.equal(view.ui.guard.classList.contains('show'), true);
});

test('confirming exit goes to the existing blank page', () => {
  const view = harness();
  view.exit.init({ elements: view.ui, target: view.windowTarget });
  view.ui.confirm.onclick();
  assert.equal(view.page.href, 'about:blank');
});

test('separate exit guards do not share a destination or an open state', () => {
  const first = harness();
  const second = harness();
  first.exit.init({ elements: first.ui, target: first.windowTarget });
  second.exit.init({ elements: second.ui, target: second.windowTarget });
  first.ui.exit.onclick();
  first.ui.confirm.onclick();
  assert.equal(first.ui.guard.classList.contains('show'), true);
  assert.equal(first.page.href, 'about:blank');
  assert.equal(second.ui.guard.classList.contains('show'), false);
  assert.equal(second.page.href, 'http://show.example/');
  assert.equal(second.exit.isEnabled(), true);
});
