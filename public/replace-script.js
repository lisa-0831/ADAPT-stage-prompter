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
    const ScriptLibrary = (deps && deps.ScriptLibrary)
      || (typeof globalThis !== 'undefined' ? globalThis.ScriptLibrary : null);
    const cryptoApi = (deps && Object.prototype.hasOwnProperty.call(deps, 'crypto') && deps.crypto)
      || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);

    let enabled = false;
    let els = null;
    let versionAttempt = null;

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
        versionAttempt = null;
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
      const headers = { 'Content-Type': 'text/plain' };
      if (ScriptLibrary && typeof ScriptLibrary.nextVersionAttempt === 'function') {
        versionAttempt = ScriptLibrary.nextVersionAttempt(versionAttempt, text, cryptoApi);
        if (versionAttempt.versionId) headers['X-Version-Id'] = versionAttempt.versionId;
      }
      const response = await request('/script', {
        method: 'POST',
        headers,
        body: text,
      });
      if (response.ok) {
        let body = null;
        if (typeof response.json === 'function') {
          try { body = await response.json(); } catch (err) { body = null; }
        }
        if (body && body.synchronized === false) {
          if (body.versionId) versionAttempt = { text, versionId: body.versionId };
          const cue = body.resetPosition === true
            ? 'The server reset the cue.'
            : 'This screen did not reset the cue.';
          notify(`Saved a new version of the live production and recorded it as live. Connected screens have not been updated. ${cue}`);
        } else {
          versionAttempt = null;
        }
        els.area.classList.remove('open');
      } else {
        notify('Upload failed — check server.');
      }
    }

    return { init };
  }

  return createReplaceScript;
}));
