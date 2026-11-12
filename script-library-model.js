(function (root, factory) {
  const scriptLibrary = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = scriptLibrary;
  } else {
    root.ScriptLibrary = scriptLibrary;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LIBRARY_IMAGE = /^library:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
  const LEGACY_IMAGE = /^images\/[A-Za-z0-9._-]+$/;

  function displayTitle(title, fallback) {
    const text = typeof title === 'string' ? title.trim() : '';
    return text || fallback;
  }

  function liveSwitchConfirmContent(currentTitle, nextTitle) {
    return {
      title: 'Set this script as Live?',
      message: 'All connected Controller, Actor, and Audience screens will receive this script.',
      notes: [
        `Current live script: ${displayTitle(currentTitle, 'Unsaved live script')}`,
        `New live script: ${displayTitle(nextTitle, 'Untitled script')}`,
        'Actors browsing the current live script may be returned to Live.',
        'The cue starts at the beginning of the selected script, because this is a different production.',
      ],
    };
  }

  function setLiveRequestState(inFlight) {
    if (inFlight) {
      return { label: 'Setting as Live...', busy: true, allowDismiss: false };
    }
    return { label: 'Set as Live', busy: false, allowDismiss: true };
  }

  function reviewedLiveRevision(entry, preview) {
    const selected = entry && typeof entry.revision === 'string' ? entry.revision : '';
    if (!preview || !entry || preview.id !== entry.id) return selected;
    return typeof preview.revision === 'string' && preview.revision
      ? preview.revision
      : selected;
  }

  function setLiveOutcome(httpOk, body) {
    if (!httpOk || !body || body.ok !== true) {
      const message = body && typeof body.error === 'string' && body.error
        ? body.error
        : 'The live script was not changed.';
      const review = Boolean(body && (body.code === 'conflict' || body.code === 'revision-required'));
      return {
        ok: false,
        closeConfirm: false,
        conflict: Boolean(body && body.code === 'conflict'),
        review,
        message,
      };
    }
    const resetPosition = body.resetPosition === true;
    let message = body.unchanged
      ? 'That script is already the live script. Connected screens were not given a new script.'
      : 'This script is now live. Connected screens have it.';
    if (resetPosition) {
      message += ' The cue is at the beginning.';
    }
    if (Number(body.missingImages) > 0) {
      message += ' Some scene images could not be found.';
    }
    return {
      ok: true,
      closeConfirm: true,
      resetPosition,
      message,
    };
  }

  function imageReference(scriptId, assetId) {
    return `library:${String(scriptId).toLowerCase()}/${String(assetId).toLowerCase()}`;
  }

  function parseImageReference(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return { kind: 'empty' };
    const libraryMatch = text.match(LIBRARY_IMAGE);
    if (libraryMatch) {
      return {
        kind: 'library',
        scriptId: libraryMatch[1].toLowerCase(),
        assetId: libraryMatch[2].toLowerCase(),
      };
    }
    if (LEGACY_IMAGE.test(text) && !text.includes('..')) {
      return { kind: 'legacy', path: text };
    }
    return { kind: 'unknown' };
  }

  function liveAssetUrl(scriptId, assetId) {
    return `/api/live/assets/${String(scriptId).toLowerCase()}/${String(assetId).toLowerCase()}`;
  }

  function imageLabel(reference, assets) {
    const parsed = parseImageReference(reference);
    if (parsed.kind === 'legacy') return parsed.path.slice('images/'.length);
    if (parsed.kind !== 'library') return '';
    const match = (assets || []).find((asset) => asset
      && asset.id === parsed.assetId
      && (!asset.scriptId || asset.scriptId === parsed.scriptId));
    return match && match.name ? match.name : 'Saved image';
  }

  return {
    liveSwitchConfirmContent,
    reviewedLiveRevision,
    setLiveRequestState,
    setLiveOutcome,
    imageReference,
    parseImageReference,
    liveAssetUrl,
    imageLabel,
  };
}));
