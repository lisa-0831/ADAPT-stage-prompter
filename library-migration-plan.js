const crypto = require('crypto');
const { parseScript } = require('./script-format');
const { imageReference, parseImageReference } = require('./script-library-model');
const { hashText, isValidScriptId } = require('./script-library');

// Pure planner: it returns a plan and does not touch the filesystem.
// Applying a plan has to wait until the server can load and recover
// migration.json. Do not commit a real migration before that.

const MIGRATION_COMMIT_BLOCKED = 'Do not commit a migration until the server loads and recovers migration.json. This planner does not activate anything.';

const HISTORICAL_IMAGE_NOTE = 'v1 keeps this images/ path. The text hash does not cover the image bytes, so replacing the shared file later changes what v1 displays.';

function planMigration(input) {
  const source = input && typeof input === 'object' ? input : {};
  const warnings = [];
  const errors = [];
  const live = asText(source.liveScript, 'The live script');
  if (live.error) return failure([live.error], warnings);
  if (!Array.isArray(source.productions)) {
    return failure([{
      code: 'invalid-input',
      message: 'Productions must be a list of saved scripts.',
    }], warnings);
  }

  const seenProductionIds = new Set();
  const seenVersionIds = new Set();
  const prepared = [];
  source.productions.forEach((entry, index) => {
    const productionId = canonicalId(entry && entry.id);
    if (!productionId) {
      errors.push({
        code: 'invalid-id',
        message: `Production ${index + 1} does not have a valid id.`,
      });
      return;
    }
    if (seenProductionIds.has(productionId)) {
      errors.push({
        code: 'duplicate-production-id',
        message: `Production ${productionId} appears more than once.`,
        productionId,
      });
      return;
    }
    seenProductionIds.add(productionId);
    const script = asText(entry.text, `Production ${productionId}`);
    if (script.error) {
      errors.push({ ...script.error, productionId });
      return;
    }
    const versionIds = entry.versions && typeof entry.versions === 'object' ? entry.versions : {};
    const v1 = claimVersionId(versionIds.v1, seenVersionIds, productionId, 'v1', errors);
    prepared.push({
      id: productionId,
      text: script.text,
      bytes: script.bytes,
      v1,
      v2Input: versionIds.v2,
      assets: entry.assets && typeof entry.assets === 'object' ? entry.assets : {},
    });
  });
  if (errors.length) return failure(errors, warnings);

  const matches = prepared.filter((production) => production.bytes.equals(live.bytes));
  if (matches.length === 0) {
    return failure([{
      code: 'no-live-match',
      message: 'No saved production matches the live script bytes.',
    }], warnings);
  }
  if (matches.length > 1) {
    return failure([{
      code: 'ambiguous-live-match',
      message: 'More than one saved production matches the live script bytes.',
      productionIds: matches.map((production) => production.id),
    }], warnings);
  }
  const selected = matches[0];
  noteLiveIdDrift(source.liveId, selected.id, warnings);

  const assetOwners = new Map();
  const productions = [];
  prepared.forEach((production) => {
    const planned = planProduction(production, seenVersionIds, assetOwners, errors, warnings);
    if (planned) productions.push(planned);
  });
  if (errors.length) return failure(errors, warnings);

  const liveProduction = productions.find((production) => production.id === selected.id);
  const head = liveProduction.versions.v2 || liveProduction.versions.v1;
  return {
    ok: true,
    warnings,
    liveProductionId: selected.id,
    pointer: {
      productionId: selected.id,
      versionId: head.id,
      contentHash: head.contentHash,
      origin: head.origin,
    },
    activation: {
      commit: false,
      reason: MIGRATION_COMMIT_BLOCKED,
    },
    productions,
  };
}

function planProduction(production, seenVersionIds, assetOwners, errors, warnings) {
  if (production.text.includes('\r')) {
    warnings.push({
      code: 'cr-line-endings',
      productionId: production.id,
      message: 'Line endings were preserved. The stage parser splits scenes on LF (\\n---\\n) and trims a trailing CR when it reads a line.',
    });
  }
  const lines = splitPreserving(production.text);
  const historicalImages = [];
  const assetMappings = [];
  const retainedLibraryReferences = [];
  const seenLegacy = new Set();
  const seenRetained = new Set();
  let needsRewrite = false;
  const rewritten = lines.map((line) => {
    const image = classifyImageLine(line.text);
    if (image.kind !== 'image') return line.text + line.ending;
    if (image.parsed.kind === 'legacy') {
      needsRewrite = true;
      const resolved = resolveAsset(production.assets, image.parsed.path);
      if (resolved.error) {
        errors.push({
          code: resolved.error,
          message: resolved.message,
          productionId: production.id,
          legacyPath: image.parsed.path,
        });
        return line.text + line.ending;
      }
      claimAsset(assetOwners, resolved.assetId, production.id, errors);
      if (!seenLegacy.has(image.parsed.path)) {
        seenLegacy.add(image.parsed.path);
        const name = image.parsed.path.slice('images/'.length);
        historicalImages.push({
          legacyPath: image.parsed.path,
          name,
          byteSnapshot: false,
          dependency: 'shared-images',
          note: HISTORICAL_IMAGE_NOTE,
        });
        assetMappings.push({
          legacyPath: image.parsed.path,
          name,
          assetId: resolved.assetId,
        });
      }
      const reference = imageReference(production.id, resolved.assetId);
      if (parseImageReference(reference).kind !== 'library') {
        errors.push({
          code: 'unrepresentable-reference',
          message: `The rewritten reference for ${image.parsed.path} is not a library image the current parser accepts.`,
          productionId: production.id,
          legacyPath: image.parsed.path,
        });
      }
      return image.prefix + reference + image.trailing + line.ending;
    }
    if (image.parsed.kind === 'library') {
      if (image.parsed.scriptId !== production.id) {
        errors.push({
          code: 'foreign-library-image',
          message: `An image reference points at production ${image.parsed.scriptId}, not ${production.id}.`,
          productionId: production.id,
          assetId: image.parsed.assetId,
        });
        return line.text + line.ending;
      }
      claimAsset(assetOwners, image.parsed.assetId, production.id, errors);
      const key = `${image.parsed.scriptId}/${image.parsed.assetId}`;
      if (!seenRetained.has(key)) {
        seenRetained.add(key);
        retainedLibraryReferences.push({
          productionId: image.parsed.scriptId,
          assetId: image.parsed.assetId,
          reference: image.token,
        });
      }
      return line.text + line.ending;
    }
    errors.push({
      code: 'unsafe-image-path',
      message: 'An image line is not a supported images/ name or a library reference.',
      productionId: production.id,
      value: image.token,
    });
    return line.text + line.ending;
  });

  if (errors.some((error) => error.productionId === production.id)) return null;

  const v1Hash = hashText(production.text);
  if (v1Hash !== hashBytes(production.bytes)) {
    errors.push({
      code: 'hash-mismatch',
      message: `The hash of production ${production.id} does not match its bytes.`,
      productionId: production.id,
    });
    return null;
  }
  const v1AssetIds = libraryAssetIds(production.text, production.id);
  const v1 = {
    id: production.v1,
    parentVersionId: null,
    origin: 'original',
    legacyImagePolicy: historicalImages.length ? 'shared-images' : (v1AssetIds.length ? 'production-assets' : 'none'),
    contentHash: v1Hash,
    text: production.text,
    assetIds: v1AssetIds,
  };
  if (!needsRewrite) {
    return {
      id: production.id,
      headVersionId: v1.id,
      versions: { v1, v2: null },
      assetMappings,
      retainedLibraryReferences,
      historicalImages,
    };
  }

  const v2Id = claimVersionId(production.v2Input, seenVersionIds, production.id, 'v2', errors);
  const v2Text = rewritten.join('');
  if (v2Text === production.text) {
    errors.push({
      code: 'rewrite-unchanged',
      message: `Production ${production.id} still has legacy image lines after rewriting.`,
      productionId: production.id,
    });
    return null;
  }
  const v2Hash = hashText(v2Text);
  if (v2Hash === v1Hash) {
    errors.push({
      code: 'hash-collision',
      message: `Production ${production.id} would report the same hash for different script bytes.`,
      productionId: production.id,
    });
  }
  confirmRewrittenScript(v2Text, production.id, errors);
  if (!v2Id) return null;
  const v2AssetIds = libraryAssetIds(v2Text, production.id);
  return {
    id: production.id,
    headVersionId: v2Id,
    versions: {
      v1,
      v2: {
        id: v2Id,
        parentVersionId: v1.id,
        origin: 'migrated',
        legacyImagePolicy: 'production-assets',
        contentHash: v2Hash,
        text: v2Text,
        assetIds: v2AssetIds,
      },
    },
    assetMappings,
    retainedLibraryReferences,
    historicalImages,
  };
}

function confirmRewrittenScript(text, productionId, errors) {
  let slides = [];
  try {
    slides = parseScript(text);
  } catch (err) {
    errors.push({
      code: 'unrepresentable-reference',
      message: `The rewritten script for ${productionId} cannot be parsed.`,
      productionId,
    });
    return;
  }
  slides.forEach((slide) => {
    if (!slide.titleImage) return;
    const parsed = parseImageReference(slide.titleImage);
    if (parsed.kind === 'library' && parsed.scriptId === productionId) return;
    errors.push({
      code: 'unrepresentable-reference',
      message: `The stage parser would not show a production-owned image for ${productionId}.`,
      productionId,
      value: slide.titleImage,
    });
  });
  splitPreserving(text).forEach((line) => {
    const image = classifyImageLine(line.text);
    if (image.kind !== 'image') return;
    if (image.parsed.kind === 'legacy') {
      errors.push({
        code: 'legacy-reference-remained',
        message: `A legacy image line remained in the rewritten script for ${productionId}.`,
        productionId,
        legacyPath: image.parsed.path,
      });
    }
  });
}

function libraryAssetIds(text, productionId) {
  const ids = [];
  splitPreserving(text).forEach((line) => {
    const image = classifyImageLine(line.text);
    if (image.kind !== 'image' || image.parsed.kind !== 'library') return;
    if (image.parsed.scriptId !== productionId) return;
    if (!ids.includes(image.parsed.assetId)) ids.push(image.parsed.assetId);
  });
  return ids;
}

function classifyImageLine(line) {
  const match = /^(\s*@image:\s*)(.*)$/.exec(line);
  if (!match) return { kind: 'text' };
  const rest = match[2];
  const trailing = (/\s*$/.exec(rest) || [''])[0];
  const token = rest.slice(0, rest.length - trailing.length);
  return {
    kind: 'image',
    prefix: match[1],
    token,
    trailing,
    parsed: parseImageReference(token),
  };
}

function resolveAsset(assets, legacyPath) {
  const name = legacyPath.slice('images/'.length);
  const byPath = Object.prototype.hasOwnProperty.call(assets, legacyPath) ? assets[legacyPath] : undefined;
  const byName = Object.prototype.hasOwnProperty.call(assets, name) ? assets[name] : undefined;
  if (byPath !== undefined && byName !== undefined && String(byPath).toLowerCase() !== String(byName).toLowerCase()) {
    return {
      error: 'ambiguous-asset-mapping',
      message: `The asset mapping for ${legacyPath} disagrees with ${name}.`,
    };
  }
  const raw = byPath !== undefined ? byPath : byName;
  if (raw === undefined) {
    return {
      error: 'missing-asset-mapping',
      message: `No owned asset was proposed for ${legacyPath}.`,
    };
  }
  const assetId = canonicalId(raw);
  if (!assetId) {
    return {
      error: 'invalid-id',
      message: `The proposed asset id for ${legacyPath} is not valid.`,
    };
  }
  return { assetId };
}

function claimAsset(owners, assetId, productionId, errors) {
  const owner = owners.get(assetId);
  if (owner && owner !== productionId) {
    errors.push({
      code: 'shared-asset-id',
      message: `Asset ${assetId} is proposed for both ${owner} and ${productionId}.`,
      assetId,
      productionId,
      otherProductionId: owner,
    });
    return;
  }
  owners.set(assetId, productionId);
}

function claimVersionId(value, seen, productionId, slot, errors) {
  const id = canonicalId(value);
  if (!id) {
    errors.push({
      code: slot === 'v2' ? 'missing-version-id' : 'invalid-id',
      message: slot === 'v2'
        ? `Production ${productionId} needs an injected v2 id before its image lines can be rewritten.`
        : `Production ${productionId} needs an injected v1 id.`,
      productionId,
    });
    return null;
  }
  if (seen.has(id)) {
    errors.push({
      code: 'duplicate-version-id',
      message: `Version ${id} is used more than once.`,
      productionId,
      versionId: id,
    });
    return null;
  }
  seen.add(id);
  return id;
}

function noteLiveIdDrift(liveId, actualProductionId, warnings) {
  if (liveId === undefined || liveId === null || liveId === '') return;
  const libraryLiveId = canonicalId(liveId);
  if (libraryLiveId === actualProductionId) return;
  warnings.push({
    code: 'live-id-drift',
    message: 'The library live id does not match the live script bytes and was ignored.',
    libraryLiveId: libraryLiveId || String(liveId),
    actualProductionId,
  });
}

function canonicalId(value) {
  if (typeof value !== 'string') return null;
  const id = value.toLowerCase();
  return isValidScriptId(id) ? id : null;
}

function asText(value, label) {
  if (typeof value === 'string') {
    return { text: value, bytes: Buffer.from(value, 'utf8') };
  }
  if (Buffer.isBuffer(value)) {
    const text = value.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(value)) {
      return { error: { code: 'invalid-script-bytes', message: `${label} is not valid UTF-8.` } };
    }
    return { text, bytes: Buffer.from(value) };
  }
  return { error: { code: 'invalid-input', message: `${label} must be a string or a byte buffer.` } };
}

function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function splitPreserving(text) {
  const parts = String(text).split(/(\r\n|\n|\r)/);
  const lines = [];
  for (let index = 0; index < parts.length; index += 2) {
    lines.push({ text: parts[index], ending: parts[index + 1] || '' });
  }
  return lines;
}

function failure(errors, warnings) {
  return {
    ok: false,
    errors,
    warnings,
    activation: {
      commit: false,
      reason: MIGRATION_COMMIT_BLOCKED,
    },
  };
}

module.exports = {
  MIGRATION_COMMIT_BLOCKED,
  HISTORICAL_IMAGE_NOTE,
  planMigration,
};
