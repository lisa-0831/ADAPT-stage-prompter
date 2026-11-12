(function (root, factory) {
  const createExitConfirmation = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = { createExitConfirmation };
  } else {
    root.PrompterExitConfirmation = createExitConfirmation();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createExitConfirmation(deps) {
    const locationRef = (deps && deps.location)
      || (typeof location !== 'undefined' ? location : null);
    const defaultTarget = (deps && deps.target)
      || (typeof window !== 'undefined' ? window : null);

    let enabled = false;
    let els = null;
    let canHandleEscape = null;
    let escapeBound = false;

    function isEnabled() {
      return enabled;
    }

    function open() {
      if (!enabled || !els) return;
      els.guard.classList.add('show');
    }

    function close() {
      if (!els) return;
      els.guard.classList.remove('show');
    }

    function confirm() {
      if (!enabled || !locationRef) return;
      locationRef.href = 'about:blank';
    }

    function onEscape(event) {
      if (!enabled || event.key !== 'Escape') return;
      if (canHandleEscape && !canHandleEscape()) return;
      event.preventDefault();
      if (els.guard.classList.contains('show')) close();
      else open();
    }

    function init(options) {
      const settings = options || {};
      enabled = true;
      els = settings.elements || null;
      canHandleEscape = settings.canHandleEscape || null;
      if (els) {
        els.exit.onclick = open;
        els.stay.onclick = close;
        els.confirm.onclick = confirm;
      }
      const target = settings.target || defaultTarget;
      if (target && !escapeBound) {
        escapeBound = true;
        target.addEventListener('keydown', onEscape);
      }
    }

    return { init, isEnabled };
  }

  return createExitConfirmation;
}));
