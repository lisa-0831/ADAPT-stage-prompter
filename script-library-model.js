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

  const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  function requestIdentity(cryptoApi) {
    if (!cryptoApi || typeof cryptoApi.randomUUID !== 'function') return null;
    let value = '';
    try { value = cryptoApi.randomUUID(); }
    catch (err) { return null; }
    if (typeof value !== 'string' || !REQUEST_ID.test(value.toLowerCase())) return null;
    return value.toLowerCase();
  }

  function nextVersionAttempt(previous, text, cryptoApi) {
    if (
      previous
      && previous.text === text
      && typeof previous.versionId === 'string'
      && REQUEST_ID.test(previous.versionId)
    ) {
      return { text, versionId: previous.versionId };
    }
    return { text, versionId: requestIdentity(cryptoApi) };
  }

  function operationFailureMessage(body) {
    const code = body && typeof body.code === 'string' ? body.code : '';
    const detail = body && typeof body.error === 'string' ? body.error : '';
    if (code === 'conflict') {
      return detail || 'This saved copy changed after you opened it. Your edits were not saved over that newer copy. The draft was kept, and a newer script was not loaded over it.';
    }
    if (code === 'stale-live') {
      return 'The live show changed after this action was prepared. This is separate from a saved-copy conflict. Nothing was rolled back. Review the current live show before trying again.';
    }
    if (code === 'activation-not-ready') {
      return 'This production cannot become live until its image references are resolved. Open the production in the editor, upload or select production-owned images, assign those images to the scene lines, save the edited script as a new version, and then set that version live. Uploading an image does not assign it to a scene. A different version was not selected.';
    }
    if (code === 'journal-conflict' || code === 'compatibility-issue' || code === 'corrupt-journal' || code === 'indeterminate') {
      return 'The server still has an unfinished live update. Recovery is required before trying again. Saved work was not discarded, and nothing was rolled back.';
    }
    if (code === 'invalid-script') {
      return `The script was not accepted. ${detail || 'It is not valid.'} The live show was not changed.`;
    }
    if (code === 'legacy-image' || code === 'invalid-image-reference' || code === 'foreign-asset' || code === 'dangling-reference' || code === 'invalid-image') {
      return `An image reference blocked this action. ${detail || 'The image is not valid for this production.'} The live show was not changed.`;
    }
    if (code === 'live-production') {
      return 'This production is live. Set another production as Live before deleting it. Nothing was deleted.';
    }
    if (code === 'delete-incomplete') {
      return detail || 'The production could not be fully removed. It is no longer listed. Other productions were not changed.';
    }
    if (code === 'saved-head-differs') {
      return 'The live show is already stored on this production, and the saved copy is a different version. The saved copy and the live text are both still there. A second production was not created, and neither copy was changed.';
    }
    if (code === 'version-exists') {
      return 'That version id was already used and was not overwritten. A second version was not created. The draft was kept.';
    }
    return null;
  }

  function setLiveOutcome(httpOk, body) {
    if (!httpOk || !body || body.ok !== true) {
      const code = body && typeof body.code === 'string' ? body.code : '';
      const review = code === 'conflict' || code === 'revision-required';
      const specific = code === 'conflict' ? null : operationFailureMessage(body);
      const message = specific
        || (body && typeof body.error === 'string' && body.error ? body.error : '')
        || (code === 'conflict'
          ? 'This saved copy changed after you reviewed it. It was not set live. A newer script was not loaded over the open draft.'
          : 'The live script was not changed.');
      return {
        ok: false,
        closeConfirm: false,
        conflict: code === 'conflict',
        review,
        code: code || null,
        message,
      };
    }
    const resetPosition = body.resetPosition === true;
    const synchronized = body.synchronized !== false;
    let message = body.unchanged
      ? 'That script is already the live script. Connected screens were not given a new script.'
      : (synchronized
        ? 'This script is now live. Connected screens have it.'
        : 'This script is recorded as live. Connected screens have not been updated.');
    if (resetPosition && synchronized) {
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

  function partialSaveOutcome(body) {
    if (!body || body.partial !== true || !body.saved || typeof body.saved !== 'object') return null;
    const titleSaved = body.saved.title === true;
    const textSaved = body.saved.text === true;
    const conflict = body.conflict && typeof body.conflict === 'object' ? body.conflict : null;
    const failedField = conflict && (conflict.field === 'title' || conflict.field === 'text')
      ? conflict.field
      : (titleSaved && !textSaved ? 'text' : (!titleSaved && textSaved ? 'title' : null));
    const reason = conflict && typeof conflict.error === 'string' ? conflict.error.trim() : '';
    const generation = body.script && Number.isInteger(body.script.generation)
      ? body.script.generation
      : null;
    let message = 'Nothing was saved. The live show was not changed.';
    if (titleSaved && textSaved) {
      message = 'The title and script were saved. The live show was not changed.';
    } else if (titleSaved) {
      message = 'The title was saved. The script text was not saved.';
    } else if (textSaved) {
      message = 'The script text was saved. The title was not saved.';
    }
    if ((titleSaved || textSaved) && !(titleSaved && textSaved)) {
      if (reason) message += ` ${reason}`;
      message += ' This update was not rolled back. The live show was not changed.';
    }
    if (generation != null && (titleSaved || textSaved)) {
      message += ` Saved generation ${generation}.`;
    }
    return {
      partial: true,
      titleSaved,
      textSaved,
      rolledBack: false,
      failedField,
      conflict,
      generation,
      message,
      script: body.script || null,
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
    requestIdentity,
    nextVersionAttempt,
    operationFailureMessage,
    setLiveOutcome,
    partialSaveOutcome,
    imageReference,
    parseImageReference,
    liveAssetUrl,
    imageLabel,
  };
}));
