(function (root, factory) {
  const createReplaceScript = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = { createReplaceScript };
  } else {
    root.PrompterReplaceScript = createReplaceScript();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createReplaceScript(deps) {
    const request = (deps && deps.fetch) || fetch;
    const notify = (deps && deps.alert) || function (message) { alert(message); };

    let enabled = false;
    let els = null;

    function init(options) {
      const settings = options || {};
      enabled = true;
      els = settings.elements || null;
      if (!els) return;
      els.toggle.onclick = function () {
        els.area.classList.toggle('open');
        if (els.area.classList.contains('open')) {
          request('/script').then(function (response) {
            return response.text();
          }).then(function (text) {
            els.textarea.value = text;
          });
        }
      };
      els.cancel.onclick = function () {
        els.area.classList.remove('open');
      };
      els.submit.onclick = function () {
        return submit();
      };
    }

    async function submit() {
      if (!enabled || !els) return;
      const text = els.textarea.value.trim();
      if (!text) return;
      const response = await request('/script', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text,
      });
      if (response.ok) {
        els.area.classList.remove('open');
      } else {
        notify('Upload failed — check server.');
      }
    }

    return { init };
  }

  return createReplaceScript;
}));
