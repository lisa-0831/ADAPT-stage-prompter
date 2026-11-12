const test = require('node:test');
const assert = require('node:assert/strict');
const PrompterText = require('./public/text');
const { toSentenceCase } = require('./caption-case');
const { createControllerView } = require('./public/controller-view');

function memoryStorage(initial) {
  const data = Object.assign({}, initial);
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
    data,
  };
}

function button() {
  const attrs = {};
  return {
    textContent: '',
    title: '',
    onclick: null,
    setAttribute(name, value) { attrs[name] = value; },
    getAttribute(name) { return attrs[name]; },
  };
}

function fakeDocument() {
  const listeners = {};
  return {
    listeners,
    addEventListener(type, fn, options) {
      listeners[type] = { fn, options };
    },
  };
}

function harness(options) {
  const settings = options || {};
  const sent = [];
  const stage = { renders: 0, render() { this.renders += 1; } };
  const doc = settings.document || fakeDocument();
  const controls = {
    btnPrev: button(),
    btnNext: button(),
    btnPrevSlide: button(),
    btnNextSlide: button(),
    btnCase: button(),
    slideSelect: { value: '2', onchange: null },
    zonePrev: button(),
    zoneNext: button(),
  };
  let allowed = settings.allowed !== false;
  const controller = createControllerView({
    text: PrompterText,
    toSentenceCase,
    stage,
    connection: { send(message) { sent.push(message); } },
    document: doc,
  });
  return { controller, sent, stage, doc, controls, allow(value) { allowed = value; }, canNavigate() { return allowed; } };
}

test('caption case starts as the original text until the controller is enabled', () => {
  const { controller } = harness();
  const original = '  HELLO THERE  ';
  assert.equal(controller.isEnabled(), false);
  assert.equal(controller.formatCue(original, 'dialogue'), original);
  assert.equal(original, '  HELLO THERE  ');
  controller.navigate('next');
  controller.selectScene('1');
  controller.toggleCase();
  assert.equal(controller.handleKey('ArrowRight'), false);
});

test('a stored sentence-case preference formats cues and labels the button', () => {
  const { controller, controls, stage } = harness();
  const storage = memoryStorage({ 'prompter-caption-case': 'sentence' });
  controller.init({ elements: controls, storage, document: fakeDocument() });

  const dialogue = 'FIRST SPOKEN LINE';
  assert.equal(controller.formatCue(dialogue, 'dialogue'), 'First spoken line');
  assert.equal(dialogue, 'FIRST SPOKEN LINE');
  assert.equal(controller.formatCue('  {SHE EXITS.}', 'direction'), 'She exits.');
  assert.equal(controller.formatCue('## SOMEWHERE ##', 'lyric'), 'Somewhere');
  assert.equal(controls.btnCase.textContent, 'Aa');
  assert.equal(controls.btnCase.getAttribute('aria-pressed'), 'true');
  assert.equal(controls.btnCase.title, 'Switch to all caps');
  assert.equal(stage.renders, 0);
});

test('toggling caption case persists the choice and repaints the stage', () => {
  const { controller, controls, stage } = harness();
  const storage = memoryStorage();
  controller.init({ elements: controls, storage, document: fakeDocument() });
  assert.equal(controls.btnCase.textContent, 'AA');

  controller.toggleCase();
  assert.equal(storage.data['prompter-caption-case'], 'sentence');
  assert.equal(controller.formatCue('HELLO', 'dialogue'), 'Hello');
  assert.equal(controls.btnCase.textContent, 'Aa');
  assert.equal(stage.renders, 1);

  controls.btnCase.onclick();
  assert.equal(storage.data['prompter-caption-case'], 'caps');
  assert.equal(controller.formatCue('HELLO', 'dialogue'), 'HELLO');
  assert.equal(stage.renders, 2);
});

test('a storage failure leaves the current page on the toggled case', () => {
  const { controller, controls } = harness();
  const storage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  controller.init({ elements: controls, storage, document: fakeDocument() });
  assert.equal(controller.formatCue('HELLO', 'dialogue'), 'HELLO');
  controller.toggleCase();
  assert.equal(controller.formatCue('HELLO', 'dialogue'), 'Hello');
});

test('navigation buttons and the scene menu send the existing commands', () => {
  const { controller, controls, sent, canNavigate } = harness({ allowed: false });
  assert.equal(sent.length, 0);
  controller.init({
    elements: controls,
    storage: memoryStorage(),
    document: fakeDocument(),
    canNavigate,
  });

  controls.btnNext.onclick();
  controls.btnPrev.onclick();
  controls.btnNextSlide.onclick();
  controls.btnPrevSlide.onclick();
  controls.zoneNext.onclick();
  controls.zonePrev.onclick();
  controls.slideSelect.value = '3';
  controls.slideSelect.onchange();

  assert.deepEqual(sent, [
    { type: 'navigate', direction: 'next' },
    { type: 'navigate', direction: 'prev' },
    { type: 'navigate', direction: 'nextSlide' },
    { type: 'navigate', direction: 'prevSlide' },
    { type: 'navigate', direction: 'next' },
    { type: 'navigate', direction: 'prev' },
    { type: 'goto', slideIndex: 3, lineIndex: 0 },
  ]);
});

test('keyboard and swipe commands wait until navigation is allowed', () => {
  const view = harness({ allowed: true });
  view.controller.init({
    elements: view.controls,
    storage: memoryStorage(),
    document: view.doc,
    canNavigate: view.canNavigate,
  });
  assert.equal(view.doc.listeners.touchstart.options.passive, true);
  assert.equal(view.doc.listeners.touchend.options.passive, true);

  assert.equal(view.controller.handleKey('ArrowRight'), true);
  assert.equal(view.controller.handleKey('ArrowUp'), true);
  assert.equal(view.controller.handleKey('PageDown'), true);
  assert.equal(view.controller.handleKey('PageUp'), true);
  assert.equal(view.controller.handleKey('Escape'), false);
  assert.deepEqual(view.sent.map((message) => message.direction), [
    'next', 'prev', 'nextSlide', 'prevSlide',
  ]);

  view.allow(false);
  assert.equal(view.controller.handleKey(' '), false);
  view.doc.listeners.touchstart.fn({ touches: [{ clientX: 200, clientY: 20 }] });
  view.doc.listeners.touchend.fn({ changedTouches: [{ clientX: 40, clientY: 20 }] });
  assert.equal(view.sent.length, 4);

  view.allow(true);
  view.doc.listeners.touchstart.fn({ touches: [{ clientX: 200, clientY: 20 }] });
  view.doc.listeners.touchend.fn({ changedTouches: [{ clientX: 150, clientY: 20 }] });
  view.doc.listeners.touchend.fn({ changedTouches: [{ clientX: 170, clientY: 120 }] });
  assert.equal(view.sent.length, 4);

  view.doc.listeners.touchstart.fn({ touches: [{ clientX: 200, clientY: 20 }] });
  view.doc.listeners.touchend.fn({ changedTouches: [{ clientX: 40, clientY: 24 }] });
  view.doc.listeners.touchstart.fn({ touches: [{ clientX: 20, clientY: 20 }] });
  view.doc.listeners.touchend.fn({ changedTouches: [{ clientX: 90, clientY: 20 }] });
  assert.deepEqual(view.sent.slice(4), [
    { type: 'navigate', direction: 'next' },
    { type: 'navigate', direction: 'prev' },
  ]);
});

test('separate controllers keep their own caption case and commands', () => {
  const first = harness();
  const second = harness();
  first.controller.init({
    elements: first.controls,
    storage: memoryStorage({ 'prompter-caption-case': 'sentence' }),
    document: first.doc,
  });
  second.controller.init({
    elements: second.controls,
    storage: memoryStorage(),
    document: second.doc,
  });
  first.controls.btnNext.onclick();
  assert.equal(first.controller.formatCue('HELLO', 'dialogue'), 'Hello');
  assert.equal(second.controller.formatCue('HELLO', 'dialogue'), 'HELLO');
  assert.equal(first.sent.length, 1);
  assert.equal(second.sent.length, 0);
  assert.equal(first.controller.isEnabled(), true);
  assert.equal(second.controller.isEnabled(), true);
});
