const crypto = require('crypto');
const { timingSafeEqual } = require('crypto');
const { hashText, isValidScriptId } = require('../script-library');

// Fixture-only HTTP adapter for the versioned library service.
//
// This module registers the existing library and script routes on a caller
// supplied application. It does not listen, open the repository library, or
// choose storage mode. Marker-free startup keeps the legacy routes.
//
// Every storage read and write goes through the injected service. This file
// does not construct a version store, production manager, asset manager, or
// live-operation factory. Those queues are not a substitute for the service
// queue. It does not fan out socket events or move the in-memory cue.
// synchronized is true only when the caller reports that the durable Live
// State transition is in server memory, the cue was adjusted, and the
// existing script and state messages were emitted. This adapter does not
// emit those messages. Without that report the field is false. Sending
// those socket messages still does not prove that every connected client
// rendered them. POST /api/library/:id/versions/:versionId/restore copies
// one committed version into a new saved head. It leaves Live State, the
// compatibility mirror, and the cue where they are. sourceVersionId is
// returned on that response and is not written into version.json.
// A durable Live commit followed
// by a synchronization failure is not a storage rollback. X-Version-Id
// retries keep the same id for the same text. The server stamps createdAt
// on each request, so a half-written version can still answer
// version-exists. The client must not mint a replacement id.
//
// Staff routes use the same X-Staff-Token comparison as server/http-routes.js.
// A missing token and a wrong token are both 401. ?role=controller is not
// authorization. GET /script, POST /script, GET /script/previous, and
// GET /api/live/assets stay public, matching the current server. Requiring a
// staff token for publish is the deferred Security S2B change.
//
// PUT /api/library/:id can carry a title and script text together. The
// service applies the title first and the script second under one queue
// turn. A script conflict after the title is saved is 409 partial. It is
// not reported as a rollback. Legacy revision remains the saved-head content
// hash. versionId, metadata generation, and Live generation are separate
// fields and are not the revision.
//
// The caller installs JSON and text parsers before these routes. Image
// uploads use a bounded raw-body reader so a large file is rejected before
// the service sees it. X-Test-Fail-At is honored only when allowFaults is
// set for the isolated harness. The running server must not set it.

const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const STATUS = {
  'invalid-id': 400,
  'invalid-script': 400,
  'invalid-image': 400,
  'incomplete-image': 400,
  'invalid-title': 400,
  'missing-title': 400,
  'invalid-image-reference': 400,
  'foreign-asset': 400,
  'legacy-image': 400,
  'generation-required': 400,
  'revision-required': 400,
  'invalid-clock': 400,
  'unsafe-path': 400,
  'missing-production': 404,
  'missing-version': 404,
  'missing-asset': 404,
  'not-live': 404,
  'no-previous-activation': 404,
  conflict: 409,
  'stale-live': 409,
  'activation-not-ready': 409,
  'unresolved-image': 409,
  'in-use': 409,
  'dangling-reference': 409,
  'version-exists': 409,
  'wrong-production': 409,
  'saved-not-live': 409,
  'journal-conflict': 409,
  'live-mismatch': 409,
  'saved-head-differs': 409,
  'too-large': 413,
  'compatibility-issue': 503,
  'corrupt-journal': 503,
  'indeterminate': 503,
  'unconfirmed-head': 503,
  'mirror-conflict': 503,
  'marker-conflict': 503,
  'not-installed': 503,
  'no-live-show': 404,
  'no-previous-activation': 404,
  'missing-live-state': 503,
  'live-state-conflict': 409,
  'not-loadable': 503,
  'missing-marker': 503,
  'invalid-live-state': 503,
  'corrupt-version': 503,
  'orphan-version': 409,
  'corrupt-metadata': 503,
  'corrupt-asset': 503,
  'corrupt-production': 503,
  closed: 503,
  'writer-active': 503,
  'storage-failure': 503,
};

function staffTokensMatch(provided, expected) {
  const left = Buffer.from(String(provided));
  const right = Buffer.from(String(expected));
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

function imageLimitMessage(limit) {
  const amount = limit >= 1024 * 1024 && limit % (1024 * 1024) === 0
    ? `${limit / (1024 * 1024)} MB`
    : `${limit} bytes`;
  return `That image is too large. Use a file of ${amount} or smaller.`;
}

function readLimitedBody(limit) {
  return function readLimitedBodyMiddleware(req, res, next) {
    const chunks = [];
    let total = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      total += chunk.length;
      if (total > limit) {
        rejected = true;
        res.status(413).json({ ok: false, code: 'too-large', error: imageLimitMessage(limit) });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected || res.headersSent) return;
      req.body = Buffer.concat(chunks);
      next();
    });
    req.on('error', () => {
      if (rejected || res.headersSent) return;
      res.status(400).json({ ok: false, code: 'invalid-image', error: 'That image could not be read.' });
    });
  };
}

function assetNameFromRequest(req) {
  const raw = req.get('X-Asset-Name') || '';
  try {
    return decodeURIComponent(raw).slice(0, 200);
  } catch (err) {
    return '';
  }
}

function jsonBody(req) {
  if (!req.body || typeof req.body !== 'object' || Buffer.isBuffer(req.body) || Array.isArray(req.body)) {
    return {};
  }
  return req.body;
}

function canonicalRouteId(value) {
  if (typeof value !== 'string') return null;
  const id = value.toLowerCase();
  return isValidScriptId(id) ? id : null;
}

function headerId(req, name) {
  const raw = req.get(name);
  if (raw == null || raw === '') return { present: false, id: null };
  const id = canonicalRouteId(raw);
  return { present: true, id };
}

function toScript(row) {
  return {
    id: row.productionId,
    title: row.title,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || row.createdAt || null,
    revision: row.contentHash,
    live: Boolean(row.live),
    versionId: row.headVersionId || row.versionId || null,
    generation: row.generation,
    activationReady: row.activationReady,
    imageStatus: row.imageStatus || null,
    sharedLegacyImages: Boolean(row.sharedLegacyImages),
    liveVersionId: row.liveVersionId || null,
    liveGeneration: row.liveGeneration == null ? null : row.liveGeneration,
  };
}

function toAsset(asset) {
  return {
    id: asset.assetId,
    assetId: asset.assetId,
    scriptId: asset.productionId,
    name: asset.name,
    mime: asset.mime,
    bytes: asset.byteLength,
    createdAt: asset.createdAt || null,
    contentHash: asset.contentHash,
    referenced: Boolean(asset.referenced),
    unassigned: Boolean(asset.unassigned),
  };
}

function sendError(res, result) {
  const code = result && result.code ? result.code : 'storage-failure';
  const status = STATUS[code] || 500;
  const body = {
    ok: false,
    code,
    error: status === 500
      ? 'The storage operation could not be completed.'
      : (result && result.error) || 'The storage operation could not be completed.',
  };
  if (result && result.imageStatus) body.imageStatus = result.imageStatus;
  if (result && result.sharedLegacyImages != null) body.sharedLegacyImages = Boolean(result.sharedLegacyImages);
  if (Array.isArray(result && result.blocking)) {
    body.blocking = result.blocking.map((item) => item && item.code).filter(Boolean);
  }
  if (result && result.field) body.field = result.field;
  if (result && result.generation != null) body.generation = result.generation;
  if (result && result.versionId) body.versionId = result.versionId;
  return res.status(status).json(body);
}

function sendSavedNotLive(res, result) {
  return res.status(409).json({
    ok: false,
    code: 'saved-not-live',
    status: 'saved-not-live',
    saved: true,
    activated: false,
    rolledBack: false,
    versionId: result && (result.versionId || result.savedVersionId) || null,
    error: 'The new version was saved and left in place. It is not live.',
  });
}

function sendAsset(res, asset) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.type(asset.mime);
  return res.send(asset.bytes);
}

function registerVersionedHttpRoutes(options) {
  const settings = options || {};
  const app = settings.app;
  const service = settings.service;
  const staffToken = settings.staffToken || '';
  const imageMaxBytes = Number.isInteger(settings.imageMaxBytes) && settings.imageMaxBytes > 0
    ? settings.imageMaxBytes
    : DEFAULT_MAX_IMAGE_BYTES;
  const allowFaults = settings.allowFaults === true;
  const createId = typeof settings.createId === 'function'
    ? settings.createId
    : () => crypto.randomUUID();
  const now = typeof settings.now === 'function' ? settings.now : () => new Date().toISOString();

  function requireStaff(req, res, next) {
    if (!staffToken) return next();
    if (staffTokensMatch(req.get('X-Staff-Token') || '', staffToken)) return next();
    return res.status(401).json({
      ok: false,
      code: 'unauthorized',
      error: 'The staff access code was not accepted.',
    });
  }

  function newId() {
    return canonicalRouteId(createId());
  }

  function createdAt() {
    const value = now();
    return typeof value === 'string' ? value : null;
  }

  function faultAt(req) {
    if (!allowFaults) return '';
    return req.get('X-Test-Fail-At') || '';
  }

  async function invoke(res, work, kind) {
    try {
      return await work();
    } catch (err) {
      const stage = err && err.stage;
      if (kind === 'publish' && (stage === 'after-save' || stage === 'before-journal')) {
        sendSavedNotLive(res, null);
        return null;
      }
      if (!res.headersSent) {
        res.status(503).json({
          ok: false,
          code: 'storage-failure',
          error: 'The storage operation could not be completed.',
        });
      }
      return null;
    }
  }

  function liveExpectation(body) {
    const expectation = {};
    if (Object.prototype.hasOwnProperty.call(body, 'expectedLiveGeneration')) {
      expectation.expectedLiveGeneration = body.expectedLiveGeneration;
    }
    if (typeof body.expectedLiveVersionId === 'string') {
      expectation.expectedLiveVersionId = body.expectedLiveVersionId;
    }
    if (typeof body.expectedLiveContentHash === 'string') {
      expectation.expectedLiveContentHash = body.expectedLiveContentHash;
    }
    return expectation;
  }

  app.get('/api/library/access', (req, res) => {
    res.json({ ok: true, required: Boolean(staffToken) });
  });

  app.get('/api/library', requireStaff, async (req, res) => {
    const listed = await invoke(res, () => service.listProductions());
    if (!listed) return undefined;
    if (!listed.ok) return sendError(res, listed);
    const liveId = listed.liveState && listed.liveState.ok && listed.liveState.present
      ? listed.liveState.productionId
      : null;
    return res.json({
      ok: true,
      order: listed.order,
      liveId,
      awaitingLive: Boolean(listed.liveState && listed.liveState.awaitingLive),
      scripts: listed.productions.map(toScript),
      invalid: listed.invalid,
      liveState: listed.liveState,
    });
  });

  app.post('/api/library', requireStaff, async (req, res) => {
    const body = jsonBody(req);
    if (body.trackIfCurrent === true) {
      const tracked = await invoke(res, () => service.resolveTrackCurrent({ text: body.text }));
      if (!tracked) return undefined;
      if (!tracked.ok) return sendError(res, tracked);
      return res.status(200).json({
        ok: true,
        unchanged: true,
        activated: false,
        tracked: true,
        trackIfCurrent: 'existing',
        script: toScript(tracked.production),
        liveId: tracked.production.productionId,
      });
    }
    const requestHeader = headerId(req, 'X-Creation-Request-Id');
    if (requestHeader.present && !requestHeader.id) {
      return res.status(400).json({
        ok: false,
        code: 'invalid-id',
        error: 'That creation request id is not valid.',
      });
    }
    const productionId = newId();
    const versionId = newId();
    const stamp = createdAt();
    if (!productionId || !versionId || productionId === versionId || !stamp) {
      return res.status(500).json({
        ok: false,
        code: 'storage-failure',
        error: 'The storage operation could not be completed.',
      });
    }
    const created = await invoke(res, () => service.createProduction({
      productionId,
      versionId,
      requestId: requestHeader.id,
      title: body.title,
      text: body.text,
      createdAt: stamp,
    }));
    if (!created) return undefined;
    if (!created.ok && created.code === 'conflict' && created.productionId) {
      const existing = await invoke(res, () => service.readProductionDetail(created.productionId));
      if (!existing) return undefined;
      if (
        existing.ok
        && existing.title === body.title
        && existing.contentHash === hashText(typeof body.text === 'string' ? body.text : '')
      ) {
        const show = await invoke(res, () => service.readLiveShow());
        if (!show) return undefined;
        return res.status(201).json({
          ok: true,
          unchanged: true,
          activated: false,
          script: toScript(existing),
          liveId: show.present ? show.productionId : null,
        });
      }
    }
    if (!created.ok) return sendError(res, created);
    const show = await invoke(res, () => service.readLiveShow());
    if (!show) return undefined;
    return res.status(201).json({
      ok: true,
      unchanged: Boolean(created.unchanged),
      activated: false,
      trackIfCurrent: body.trackIfCurrent === true ? 'ignored' : 'not-requested',
      script: toScript({
        productionId: created.productionId,
        title: created.title,
        createdAt: created.createdAt,
        updatedAt: created.createdAt,
        contentHash: created.contentHash,
        live: false,
        headVersionId: created.versionId,
        generation: created.generation,
        activationReady: created.activationReady,
        imageStatus: created.imageStatus,
        sharedLegacyImages: created.imageStatus === 'unresolved-shared-images',
      }),
      liveId: show.ok && show.present ? show.productionId : null,
    });
  });

  app.get('/api/library/:id', requireStaff, async (req, res) => {
    const productionId = canonicalRouteId(req.params.id);
    if (!productionId) {
      return res.status(400).json({ ok: false, code: 'invalid-id', error: 'That script id is not valid.' });
    }
    const detail = await invoke(res, () => service.readProductionDetail(productionId));
    if (!detail) return undefined;
    if (!detail.ok) return sendError(res, detail);
    return res.json({
      ok: true,
      script: Object.assign(toScript(detail), { text: detail.text }),
      liveId: detail.liveProductionId || null,
    });
  });

  app.put('/api/library/:id', requireStaff, async (req, res) => {
    const productionId = canonicalRouteId(req.params.id);
    if (!productionId) {
      return res.status(400).json({ ok: false, code: 'invalid-id', error: 'That script id is not valid.' });
    }
    const body = jsonBody(req);
    const versionHeader = headerId(req, 'X-Version-Id');
    if (versionHeader.present && !versionHeader.id) {
      return res.status(400).json({ ok: false, code: 'invalid-id', error: 'That version id is not valid.' });
    }
    const changes = {
      productionId,
      expectedRevision: body.expectedRevision,
      newVersionId: versionHeader.id,
      createdAt: createdAt(),
    };
    if (Object.prototype.hasOwnProperty.call(body, 'title')) changes.title = body.title;
    if (Object.prototype.hasOwnProperty.call(body, 'text')) changes.text = body.text;
    if (Object.prototype.hasOwnProperty.call(body, 'expectedGeneration')) {
      changes.expectedGeneration = body.expectedGeneration;
    }
    if (typeof body.expectedVersionId === 'string') changes.expectedVersionId = body.expectedVersionId;
    const updated = await invoke(res, () => service.updateProduction(changes));
    if (!updated) return undefined;
    if (updated.partial) {
      return res.status(409).json({
        ok: false,
        partial: true,
        code: 'partial',
        error: updated.titleSaved
          ? 'The title was saved. The script was not saved.'
          : 'The script was not saved.',
        saved: { title: Boolean(updated.titleSaved), text: false },
        conflict: { field: 'text', code: updated.code, error: updated.error },
        script: updated.production ? toScript(updated.production) : null,
        liveId: updated.production ? updated.production.liveProductionId : null,
      });
    }
    if (!updated.ok) return sendError(res, updated);
    return res.json({
      ok: true,
      unchanged: Boolean(updated.unchanged),
      script: toScript(updated.production),
      liveId: updated.production.liveProductionId || null,
    });
  });

  app.get('/api/library/:id/versions', requireStaff, async (req, res) => {
    const productionId = canonicalRouteId(req.params.id);
    if (!productionId) {
      return res.status(400).json({ ok: false, code: 'invalid-id', error: 'That script id is not valid.' });
    }
    const listed = await invoke(res, () => service.listProductionVersions(productionId));
    if (!listed) return undefined;
    if (!listed.ok) return sendError(res, listed);
    return res.json(listed);
  });

  app.get('/api/library/:id/versions/:versionId', requireStaff, async (req, res) => {
    const productionId = canonicalRouteId(req.params.id);
    const versionId = canonicalRouteId(req.params.versionId);
    if (!productionId || !versionId) {
      return res.status(400).json({ ok: false, code: 'invalid-id', error: 'That production or version id is not valid.' });
    }
    const detail = await invoke(res, () => service.readProductionVersion({ productionId, versionId }));
    if (!detail) return undefined;
    if (detail.code === 'orphan-version') {
      return res.status(409).json({
        ok: false,
        code: 'orphan-version',
        error: detail.error,
        orphan: {
          versionId: detail.versionId,
          complete: detail.complete === true,
          committed: false,
        },
      });
    }
    if (!detail.ok) return sendError(res, detail);
    return res.json(detail);
  });

  app.post('/api/library/:id/versions/:versionId/restore', requireStaff, async (req, res) => {
    const productionId = canonicalRouteId(req.params.id);
    const sourceVersionId = canonicalRouteId(req.params.versionId);
    if (!productionId || !sourceVersionId) {
      return res.status(400).json({ ok: false, code: 'invalid-id', error: 'That production or version id is not valid.' });
    }
    const body = jsonBody(req);
    const versionHeader = headerId(req, 'X-Version-Id');
    if (!versionHeader.id) {
      return res.status(400).json({ ok: false, code: 'invalid-id', error: 'A restored version needs its own id.' });
    }
    if (typeof body.expectedVersionId !== 'string') {
      return res.status(400).json({ ok: false, code: 'invalid-id', error: 'The saved head that was reviewed is required.' });
    }
    const stamp = createdAt();
    if (!stamp) {
      return res.status(400).json({ ok: false, code: 'invalid-clock', error: 'A version needs a creation time.' });
    }
    const restored = await invoke(res, () => service.restoreSavedVersion({
      productionId,
      sourceVersionId,
      expectedVersionId: body.expectedVersionId,
      newVersionId: versionHeader.id,
      createdAt: stamp,
    }));
    if (!restored) return undefined;
    if (restored.code === 'orphan-version') {
      return res.status(409).json({
        ok: false,
        code: 'orphan-version',
        error: restored.error,
        orphan: {
          versionId: restored.versionId,
          complete: restored.complete === true,
          committed: false,
        },
      });
    }
    if (restored.code === 'conflict') {
      return res.status(409).json({
        ok: false,
        code: 'conflict',
        error: restored.error,
        currentVersionId: restored.currentVersionId || null,
      });
    }
    if (!restored.ok) return sendError(res, restored);
    return res.status(restored.unchanged ? 200 : 201).json(restored);
  });

  app.get('/api/library/:id/assets', requireStaff, async (req, res) => {
    const productionId = canonicalRouteId(req.params.id);
    if (!productionId) {
      return res.status(400).json({ ok: false, code: 'invalid-id', error: 'That script id is not valid.' });
    }
    const listed = await invoke(res, () => service.listAssets(productionId));
    if (!listed) return undefined;
    if (!listed.ok) return sendError(res, listed);
    return res.json({ ok: true, assets: listed.assets.map(toAsset) });
  });

  app.post('/api/library/:id/assets', requireStaff, readLimitedBody(imageMaxBytes), async (req, res) => {
    const productionId = canonicalRouteId(req.params.id);
    if (!productionId) {
      return res.status(400).json({ ok: false, code: 'invalid-id', error: 'That script id is not valid.' });
    }
    const assetHeader = headerId(req, 'X-Asset-Id');
    const requestHeader = headerId(req, 'X-Upload-Request-Id');
    if ((assetHeader.present && !assetHeader.id) || (requestHeader.present && !requestHeader.id)) {
      return res.status(400).json({ ok: false, code: 'invalid-id', error: 'That image id is not valid.' });
    }
    const assetId = assetHeader.id || newId();
    if (!assetId) {
      return res.status(500).json({
        ok: false,
        code: 'storage-failure',
        error: 'The storage operation could not be completed.',
      });
    }
    const saved = await invoke(res, () => service.uploadAsset({
      productionId,
      assetId,
      requestId: requestHeader.id,
      name: assetNameFromRequest(req),
      body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    }));
    if (!saved) return undefined;
    if (!saved.ok) return sendError(res, saved);
    return res.status(201).json({
      ok: true,
      unchanged: Boolean(saved.unchanged),
      asset: toAsset(saved.asset),
    });
  });

  app.get('/api/library/:id/assets/:assetId', requireStaff, async (req, res) => {
    const productionId = canonicalRouteId(req.params.id);
    const assetId = canonicalRouteId(req.params.assetId);
    if (!productionId || !assetId) return res.status(404).type('text/plain').send('Not found');
    const asset = await invoke(res, () => service.readAsset(productionId, assetId));
    if (!asset) return undefined;
    if (!asset.ok) return res.status(404).type('text/plain').send('Not found');
    return sendAsset(res, asset);
  });

  app.delete('/api/library/:id/assets/:assetId', requireStaff, async (req, res) => {
    const productionId = canonicalRouteId(req.params.id);
    const assetId = canonicalRouteId(req.params.assetId);
    if (!productionId || !assetId) {
      return res.status(400).json({ ok: false, code: 'invalid-id', error: 'That image could not be found.' });
    }
    const removed = await invoke(res, () => service.deleteAsset({ productionId, assetId }));
    if (!removed) return undefined;
    if (!removed.ok) return sendError(res, removed);
    return res.json({ ok: true });
  });

  app.get('/api/live/assets/:productionId/:assetId', async (req, res) => {
    const productionId = canonicalRouteId(req.params.productionId);
    const assetId = canonicalRouteId(req.params.assetId);
    if (!productionId || !assetId) return res.status(404).type('text/plain').send('Not found');
    const asset = await invoke(res, () => service.readLiveAsset(productionId, assetId));
    if (!asset || !asset.ok) {
      if (!res.headersSent) return res.status(404).type('text/plain').send('Not found');
      return undefined;
    }
    return sendAsset(res, asset);
  });

  app.post('/api/library/:id/live', requireStaff, async (req, res) => {
    const productionId = canonicalRouteId(req.params.id);
    if (!productionId) {
      return res.status(400).json({ ok: false, code: 'invalid-id', error: 'That script id is not valid.' });
    }
    const body = jsonBody(req);
    const activated = await invoke(res, () => service.activateSavedHead(Object.assign({
      productionId,
      expectedRevision: body.expectedRevision,
      failAt: faultAt(req),
    }, liveExpectation(body))));
    if (!activated) return undefined;
    if (activated.status === 'saved-not-live') return sendSavedNotLive(res, activated);
    if (!activated.ok) return sendError(res, activated);
    return res.json({
      ok: true,
      unchanged: Boolean(activated.unchanged),
      resetPosition: Boolean(activated.resetPosition),
      revision: activated.contentHash,
      liveId: activated.productionId,
      title: activated.title || '',
      previousTitle: activated.previousTitle || '',
      versionId: activated.versionId,
      generation: activated.generation,
      cue: activated.cue || null,
      missingImages: 0,
      activated: true,
      synchronized: activated.synchronized === true,
    });
  });

  app.post('/script', async (req, res) => {
    if (req.get('X-Restore-Previous') === '1') {
      if (typeof req.body !== 'string') {
        return res.status(400).json({
          ok: false,
          code: 'invalid-script',
          error: 'The previous script could not be restored. The live show was not changed.',
        });
      }
      const restored = await invoke(res, () => service.restoreCurrent({
        text: req.body,
        failAt: faultAt(req),
      }));
      if (!restored) return undefined;
      if (!restored.ok) {
        if (restored.code === 'no-previous-activation') {
          return res.status(404).json({
            ok: false,
            code: 'no-previous-activation',
            error: 'No previous script',
          });
        }
        return sendError(res, restored);
      }
      return res.json({
        ok: true,
        revision: restored.contentHash,
        unchanged: Boolean(restored.unchanged),
        liveScriptId: restored.productionId,
        versionId: restored.versionId,
        generation: restored.generation,
        libraryUpdated: false,
        libraryConflict: false,
        cue: restored.cue || null,
        resetPosition: Boolean(restored.cue && restored.cue.action === 'reset'),
        activated: true,
        synchronized: restored.synchronized === true,
      });
    }
    if (typeof req.body !== 'string') {
      return res.status(400).json({ ok: false, code: 'invalid-script', error: 'The script could not be read.' });
    }
    const libraryHeader = headerId(req, 'X-Library-Id');
    if (libraryHeader.present && !libraryHeader.id) {
      return res.status(400).json({ ok: false, code: 'invalid-id', error: 'That script id is not valid.' });
    }
    const versionHeader = headerId(req, 'X-Version-Id');
    if (versionHeader.present && !versionHeader.id) {
      return res.status(400).json({ ok: false, code: 'invalid-id', error: 'That version id is not valid.' });
    }
    const published = await invoke(res, () => service.publishCurrent({
      productionId: libraryHeader.id,
      text: req.body,
      expectedRevision: req.get('X-Library-Revision') || '',
      newVersionId: versionHeader.id,
      createdAt: createdAt(),
      resetPosition: req.get('X-Reset-Position') === '1',
      failAt: faultAt(req),
    }), 'publish');
    if (!published) return undefined;
    if (published.status === 'saved-not-live') return sendSavedNotLive(res, published);
    if (!published.ok) return sendError(res, published);
    return res.json({
      ok: true,
      revision: published.contentHash,
      unchanged: Boolean(published.unchanged),
      liveScriptId: published.productionId,
      versionId: published.versionId,
      savedVersionId: published.savedVersionId || published.versionId,
      generation: published.generation,
      libraryUpdated: !published.unchanged,
      libraryConflict: false,
      cue: published.cue || null,
      resetPosition: Boolean(published.cue && published.cue.action === 'reset'),
      activated: true,
      synchronized: published.synchronized === true,
    });
  });

  app.get('/script/previous', async (req, res) => {
    const show = await invoke(res, () => service.readLiveShow());
    if (!show) return undefined;
    if (!show.ok) return sendError(res, show);
    if (!show.present || !show.previousActivation) {
      return res.status(404).json({ ok: false, code: 'no-previous-activation', error: 'No previous script' });
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(show.previousActivation.text);
  });

  app.get('/script', async (req, res) => {
    const show = await invoke(res, () => service.readLiveShow());
    if (!show) return undefined;
    if (show.ok && show.awaitingLive) {
      return res.status(404).json({ ok: false, code: 'no-live-show', error: 'No script is currently live.' });
    }
    if (!show.ok || !show.present) {
      return sendError(res, show.ok ? { code: 'not-installed', error: 'The versioned show has not finished initial installation.' } : show);
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(show.text);
  });
}

module.exports = { registerVersionedHttpRoutes };
