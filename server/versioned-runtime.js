const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');
const { parseScript, positionAfterScriptReplace } = require('../script-format');
const { mountBrowserShell } = require('./http-routes');
const { registerLiveSocketHandlers } = require('./live-socket');
const { loadVersionedShow } = require('./versioned-show');
const { installVersionedLive } = require('./versioned-live-install');
const { createVersionedLibraryService } = require('./versioned-library-service');
const { registerVersionedHttpRoutes } = require('./versioned-http-routes');
const { acquireStorageWriter } = require('./storage-writer-lock');
const {
  persistentAuthorizationAccepted,
  retainPersistentRoot,
  releasePersistentRoot,
  authorizeVersionedPersistentRoot,
  beginPersistentMigration,
} = require('./persistent-authorization');

// Versioned startup accepts either authorizeVersionedFixture for one
// temporary directory, or authorizeVersionedPersistentRoot for one
// authorized persistent directory. A committed marker is required. This
// module does not read an environment variable, header, or query parameter
// to grant that permission, and it does not open the repository library.

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_AUTH = Symbol('adapt.versionedFixtureAuthorization');

class VersionedStartupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VersionedStartupError';
    this.code = code;
  }
}

function failure(code, error) {
  return { ok: false, code, error };
}

function insideStrict(child, parent) {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function createLiveGenerationGuard() {
  let applied = null;
  return {
    current() {
      return applied;
    },
    accept(generation) {
      if (!Number.isInteger(generation) || generation < 1) return false;
      if (applied !== null && generation < applied) return false;
      applied = generation;
      return true;
    },
  };
}

function authorizeRoot(root) {
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0') || !path.isAbsolute(root)) {
    return failure('root-required', 'An explicit absolute fixture root is required.');
  }
  const lexical = path.resolve(root);
  let stat;
  try {
    stat = fs.lstatSync(lexical);
  } catch (err) {
    stat = null;
  }
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    return failure('unsafe-root', 'The fixture root must be a real directory.');
  }
  let rootReal;
  try {
    rootReal = fs.realpathSync(lexical);
  } catch (err) {
    return failure('unsafe-root', 'The fixture root could not be resolved.');
  }
  const repoReal = fs.realpathSync(REPO_ROOT);
  const tmpReal = fs.realpathSync(os.tmpdir());
  if (rootReal === repoReal || insideStrict(rootReal, repoReal) || insideStrict(repoReal, rootReal)) {
    return failure('unsafe-root', 'Versioned startup is limited to an explicit temporary fixture.');
  }
  if (rootReal === tmpReal || !insideStrict(rootReal, tmpReal)) {
    return failure('unsafe-root', 'Versioned startup is limited to an explicit temporary fixture.');
  }
  return { ok: true, rootReal };
}

function rejectSymlinkWalk(rootReal, realPath, kind) {
  const relative = path.relative(rootReal, realPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return failure('unsafe-path', `The ${kind} path is outside the fixture root.`);
  }
  const parts = relative.split(path.sep).filter(Boolean);
  let current = rootReal;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      return failure('unsafe-path', `The ${kind} path could not be read.`);
    }
    if (stat.isSymbolicLink()) {
      return failure('unsafe-path', `The ${kind} path must not contain a symlink.`);
    }
  }
  return { ok: true };
}

function inspectContained(rootReal, target, kind, directory) {
  if (typeof target !== 'string' || target.length === 0 || target.includes('\0') || !path.isAbsolute(target)) {
    return failure('unsafe-path', `The ${kind} path must be an explicit absolute path inside the fixture.`);
  }
  const lexical = path.resolve(target);
  let existing = lexical;
  const missingParts = [];
  while (true) {
    let stat;
    try {
      stat = fs.lstatSync(existing);
      if (stat.isSymbolicLink()) {
        return failure('unsafe-path', `The ${kind} path must not contain a symlink.`);
      }
      break;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        return failure('unsafe-path', `The ${kind} path could not be read.`);
      }
      if (existing === path.dirname(existing)) {
        return failure('unsafe-path', `The ${kind} path is outside the fixture root.`);
      }
      missingParts.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
  let existingReal;
  try {
    existingReal = fs.realpathSync(existing);
  } catch (err) {
    return failure('unsafe-path', `The ${kind} path could not be resolved.`);
  }
  if (!insideStrict(existingReal, rootReal)) {
    return failure('unsafe-path', `The ${kind} path is outside the fixture root.`);
  }
  const walked = rejectSymlinkWalk(rootReal, existingReal, kind);
  if (!walked.ok) return walked;
  if (missingParts.length) {
    if (missingParts.some((part) => part === '.' || part === '..' || part.length === 0)) {
      return failure('unsafe-path', `The ${kind} path is outside the fixture root.`);
    }
    const created = path.resolve(existingReal, missingParts.join(path.sep));
    if (!insideStrict(created, rootReal)) {
      return failure('unsafe-path', `The ${kind} path is outside the fixture root.`);
    }
    return { ok: true, lexical: created, real: null, missing: true };
  }
  let finalStat;
  try {
    finalStat = fs.lstatSync(existingReal);
  } catch (err) {
    return failure('unsafe-path', `The ${kind} path could not be read.`);
  }
  if (directory) {
    if (!finalStat.isDirectory()) return failure('unsafe-path', `The ${kind} path must be a real directory.`);
  } else if (!finalStat.isFile()) {
    return failure('unsafe-path', `The ${kind} path must be a real file.`);
  }
  return { ok: true, lexical: existingReal, real: existingReal, missing: false };
}

function requireReady(located, kind, directory) {
  if (!located.ok) return located;
  if (located.missing) {
    return failure('unsafe-path', `The ${kind} path must be a real ${directory ? 'directory' : 'file'} inside the fixture.`);
  }
  return located;
}

function validateFixture(spec) {
  const settings = spec || {};
  const root = authorizeRoot(settings.root);
  if (!root.ok) return root;
  const library = requireReady(inspectContained(root.rootReal, settings.libraryDir, 'library', true), 'library', true);
  if (!library.ok) return library;
  const script = requireReady(inspectContained(root.rootReal, settings.scriptFile, 'script mirror', false), 'script mirror', false);
  if (!script.ok) return script;
  const previous = requireReady(inspectContained(root.rootReal, settings.previousFile, 'previous script', false), 'previous script', false);
  if (!previous.ok) return previous;
  const metaPath = `${previous.lexical}.meta.json`;
  const meta = requireReady(inspectContained(root.rootReal, metaPath, 'previous metadata', false), 'previous metadata', false);
  if (!meta.ok) return meta;
  const journal = inspectContained(root.rootReal, settings.journalDir, 'journal', true);
  if (!journal.ok) return journal;
  if (!journal.missing) {
    const ready = requireReady(journal, 'journal', true);
    if (!ready.ok) return ready;
  }
  return {
    ok: true,
    root: root.rootReal,
    libraryDir: library.real,
    scriptFile: script.real,
    previousFile: previous.real,
    metaFile: meta.real,
    journalDir: journal.missing ? journal.lexical : journal.real,
  };
}

function authorizeVersionedFixture(spec) {
  const checked = validateFixture(spec);
  if (!checked.ok) {
    const error = new VersionedStartupError(checked.code, checked.error);
    throw error;
  }
  return Object.freeze({
    [FIXTURE_AUTH]: true,
    root: checked.root,
    libraryDir: checked.libraryDir,
    scriptFile: checked.scriptFile,
    previousFile: checked.previousFile,
    metaFile: checked.metaFile,
    journalDir: checked.journalDir,
  });
}

function fixtureAuthorizationAccepted(token, paths) {
  if (!token || token[FIXTURE_AUTH] !== true) return false;
  const fromToken = validateFixture(token);
  const settings = paths || {};
  const fromServer = validateFixture({
    root: token.root,
    libraryDir: settings.libraryDir,
    scriptFile: settings.scriptFile,
    previousFile: settings.previousFile,
    journalDir: settings.journalDir,
  });
  if (!fromToken.ok || !fromServer.ok) return false;
  return fromToken.root === fromServer.root
    && fromToken.libraryDir === fromServer.libraryDir
    && fromToken.scriptFile === fromServer.scriptFile
    && fromToken.previousFile === fromServer.previousFile
    && fromToken.journalDir === fromServer.journalDir;
}

function startupError(code, message) {
  return new VersionedStartupError(code, message);
}

function ensureJournal(journalDir, rootReal) {
  const located = inspectContained(rootReal, journalDir, 'journal', true);
  if (!located.ok) throw startupError(located.code, located.error);
  if (!located.missing) return located.real;
  fs.mkdirSync(located.lexical, { recursive: true });
  const created = requireReady(inspectContained(rootReal, journalDir, 'journal', true), 'journal', true);
  if (!created.ok) throw startupError(created.code, created.error);
  return created.real;
}

function imageLimit(options) {
  const configuredLimit = Number(process.env.PROMPTER_IMAGE_MAX_BYTES);
  if (Number.isInteger(options.imageMaxBytes) && options.imageMaxBytes > 0) return options.imageMaxBytes;
  if (Number.isInteger(configuredLimit) && configuredLimit > 0) return configuredLimit;
  return 10 * 1024 * 1024;
}

async function bootAuthorizedVersionedServer(options) {
  const settings = options || {};
  const token = settings.versionedFixture;
  const persistent = settings.persistentRoot;
  const persistentOk = persistentAuthorizationAccepted(persistent, {
    libraryDir: persistent && persistent.libraryDir,
    scriptFile: persistent && persistent.scriptFile,
    previousFile: persistent && persistent.previousFile,
    journalDir: persistent && persistent.journalDir,
  });
  if (persistentOk && token && token[FIXTURE_AUTH] === true) {
    throw startupError('ambiguous-authorization', 'Versioned startup received both a fixture token and a persistent-root token.');
  }
  let checked;
  if (persistentOk) {
    checked = {
      ok: true,
      root: persistent.root,
      libraryDir: persistent.libraryDir,
      scriptFile: persistent.scriptFile,
      previousFile: persistent.previousFile,
      metaFile: persistent.metaFile,
      journalDir: persistent.journalDir,
    };
    retainPersistentRoot(checked.root);
  } else {
    checked = validateFixture(token);
    if (!checked.ok || !token || token[FIXTURE_AUTH] !== true) {
      throw startupError('fixture-unauthorized', 'Versioned startup was not authorized for this fixture.');
    }
  }
  const maxImageBytes = imageLimit(settings);
  const staffToken = settings.staffToken !== undefined
    ? settings.staffToken
    : (process.env.PROMPTER_STAFF_TOKEN || '');
  let service = null;
  let ownership = null;
  let shutdown = null;
  function release() {
    if (!shutdown) {
      shutdown = (async () => {
        if (service && service.ok === true && typeof service.close === 'function') {
          await service.close();
        }
        if (ownership) {
          ownership.release();
          ownership = null;
        }
        if (persistentOk) releasePersistentRoot(checked.root);
      })();
    }
    return shutdown;
  }
  try {
    ownership = acquireStorageWriter(checked.libraryDir);
    const journalDir = ensureJournal(checked.journalDir, checked.root);
    const guard = createLiveGenerationGuard();
    const deferred = [];
    let slides = [];
    let revision = '';
    let liveRaw = '';
    let productionId = null;
    let awaitingLive = false;
    let state = {
      slideIndex: 0,
      lineIndex: 0,
      showLine: true,
      showTitleImage: false,
    };
    let wss = null;

    function updateCue(fields) {
      if (Object.prototype.hasOwnProperty.call(fields, 'slideIndex')) state.slideIndex = fields.slideIndex;
      if (Object.prototype.hasOwnProperty.call(fields, 'lineIndex')) state.lineIndex = fields.lineIndex;
      if (Object.prototype.hasOwnProperty.call(fields, 'showTitleImage')) state.showTitleImage = fields.showTitleImage;
    }

    function broadcast(message) {
      if (!wss) return;
      let data;
      try {
        data = JSON.stringify(message);
      } catch (err) {
        console.error(err);
        return;
      }
      wss.clients.forEach((client) => {
        if (client.readyState !== WebSocket.OPEN) return;
        try {
          client.send(data);
        } catch (err) {
          console.error(err);
        }
      });
    }

    function applyShow(show, cue, restart) {
      const nextSlides = parseScript(show.text);
      if (!Array.isArray(nextSlides) || nextSlides.length === 0) {
        return {
          synchronized: false,
          code: 'invalid-script',
          error: 'The active script could not be parsed.',
        };
      }
      if (!guard.accept(show.generation)) {
        return {
          synchronized: false,
          code: 'stale-generation',
          error: 'An older live generation was not applied.',
        };
      }
      slides = nextSlides;
      revision = show.contentHash;
      liveRaw = show.text;
      productionId = show.productionId;
      awaitingLive = false;
      if (restart || (cue && cue.action === 'reset')) {
        state.slideIndex = 0;
        state.lineIndex = 0;
        state.showLine = true;
        state.showTitleImage = Boolean(nextSlides[0] && nextSlides[0].titleImage);
      } else {
        const next = positionAfterScriptReplace(state, nextSlides);
        state.slideIndex = next.slideIndex;
        state.lineIndex = next.lineIndex;
      }
      broadcast({
        type: 'script',
        slides,
        revision,
        liveScriptId: productionId,
      });
      broadcast({ type: 'state', state });
      return { synchronized: true };
    }

    function readVerifiedShow() {
      return loadVersionedShow({
        libraryDir: checked.libraryDir,
        scriptFile: checked.scriptFile,
        maxImageBytes,
      });
    }

    function onLiveCommit(result) {
      if (settings.failSynchronization === 'throw') {
        throw new Error('The live show was committed, but this process could not update its memory.');
      }
      const job = () => {
        const show = readVerifiedShow();
        if (!show.ok || show.status !== 'loadable') {
          return {
            synchronized: false,
            code: show.code || 'not-loadable',
            error: show.error || 'The committed live show could not be loaded.',
          };
        }
        if (result && result.versionId && show.versionId !== result.versionId) {
          return { synchronized: false, code: 'stale-generation' };
        }
        if (result && Number.isInteger(result.generation) && show.generation !== result.generation) {
          return { synchronized: false, code: 'stale-generation' };
        }
        return applyShow(show, result && result.cue, false);
      };
      if (settings.deferSynchronization) {
        deferred.push(job);
        return { synchronized: false };
      }
      return job();
    }

    service = createVersionedLibraryService({
      root: checked.root,
      libraryDir: checked.libraryDir,
      scriptFile: checked.scriptFile,
      journalDir,
      now: settings.now,
      createId: settings.createId,
      maxImageBytes,
      onLiveCommit,
    });
    if (!service.ok) {
      throw startupError(service.code || 'unsafe-path', 'The versioned library could not be opened.');
    }

    const recovered = await service.recoverLiveOperations();
    if (!recovered || recovered.ok !== true) {
      throw startupError(
        (recovered && recovered.code) || 'corrupt-journal',
        (recovered && recovered.error) || 'The versioned journal could not be recovered.',
      );
    }
    if (recovered.reason === 'pending') {
      throw startupError('pending-journal', 'A pending versioned journal is still present. It was left in place.');
    }

    let show = readVerifiedShow();
    if (show && show.ok && show.status === 'initialization-required') {
      const installed = installVersionedLive({
        root: checked.root,
        libraryDir: checked.libraryDir,
        scriptFile: checked.scriptFile,
        previousFile: checked.previousFile,
        metaFile: checked.metaFile,
        journalDir,
        now: settings.now,
        maxImageBytes,
      });
      if (!installed || installed.ok !== true) {
        throw startupError(
          (installed && installed.code) || 'install-failed',
          (installed && installed.error) || 'The initial live installation did not finish.',
        );
      }
      show = readVerifiedShow();
    }
    if (show && show.ok === true && show.status === 'awaiting-live') {
      awaitingLive = true;
    } else if (!show || show.ok !== true || show.status !== 'loadable' || typeof show.text !== 'string') {
      throw startupError(
        (show && show.code) || 'not-loadable',
        (show && show.error) || 'The versioned live show is not ready to start.',
      );
    }

    const app = express();
    const server = http.createServer(app);
    wss = new WebSocket.Server({ server });
    if (!awaitingLive) {
      const installedMemory = applyShow(show, null, true);
      if (!installedMemory.synchronized) {
        await new Promise((resolve) => wss.close(() => server.close(() => resolve())));
        throw startupError(installedMemory.code || 'invalid-script', installedMemory.error || 'The active script could not be parsed.');
      }
    }

    function reloadVerified() {
      if (awaitingLive) {
        return {
          ok: false,
          code: 'no-live-show',
          error: 'No script is currently live. The compatibility mirror was not adopted.',
        };
      }
      const current = readVerifiedShow();
      if (!current || current.ok !== true || current.status !== 'loadable' || typeof current.text !== 'string') {
        return {
          ok: false,
          code: (current && current.code) || 'reload-refused',
          error: 'The live script was not reloaded. The compatibility mirror was not adopted.',
        };
      }
      let mirror;
      try {
        const stat = fs.lstatSync(checked.scriptFile);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          return { ok: false, code: 'unsafe-path', error: 'The compatibility mirror could not be read.' };
        }
        mirror = fs.readFileSync(checked.scriptFile);
      } catch (err) {
        return { ok: false, code: 'unsafe-path', error: 'The compatibility mirror could not be read.' };
      }
      if (!mirror.equals(Buffer.from(current.text, 'utf8'))) {
        return {
          ok: false,
          code: 'mirror-conflict',
          error: 'The compatibility mirror does not match the active version. It was not loaded.',
        };
      }
      const applied = applyShow(current, { action: 'reset' }, true);
      if (!applied.synchronized) {
        return {
          ok: false,
          code: applied.code || 'reload-refused',
          error: applied.error || 'The live script was not reloaded.',
        };
      }
      return { ok: true };
    }

    mountBrowserShell(app, {
      staticRoot: settings.staticRoot,
      libraryDir: checked.libraryDir,
      journalDir,
    });
    registerVersionedHttpRoutes({
      app,
      service,
      staffToken,
      imageMaxBytes: maxImageBytes,
      createId: settings.createId,
      now: settings.now,
      allowFaults: settings.allowFaults === true,
    });
    app.use((req, res) => {
      res.status(404).type('text/plain').send('Not found');
    });
    registerLiveSocketHandlers({
      wss,
      getSlides() { return awaitingLive ? [] : slides; },
      getState() { return state; },
      getScriptRevision() { return awaitingLive ? null : revision; },
      getLiveScriptId() { return awaitingLive ? null : productionId; },
      getAwaitingLive() { return awaitingLive; },
      updateCue,
      broadcast,
      loadScript: reloadVerified,
    });

    server.on('close', () => {
      release();
    });

    return {
      app,
      server,
      wss,
      service,
      mode: 'versioned',
      loadScript: reloadVerified,
      close() {
        wss.clients.forEach((client) => {
          try { client.terminate(); } catch (err) { /* The client is already gone. */ }
        });
        return new Promise((resolve) => {
          wss.close(() => server.close(() => resolve()));
        }).then(() => release());
      },
      applyDeferredSynchronizations(order) {
        const jobs = deferred.splice(0, deferred.length);
        const indexes = Array.isArray(order) ? order : jobs.map((job, index) => index);
        return indexes.map((index) => jobs[index]());
      },
      getSlides() { return awaitingLive ? [] : slides; },
      getState() { return state; },
      getScriptRevision() { return awaitingLive ? null : revision; },
      getLiveScriptId() { return awaitingLive ? null : productionId; },
      getAwaitingLive() { return awaitingLive; },
      getLiveRaw() { return awaitingLive ? '' : liveRaw; },
    };
  } catch (err) {
    await release();
    throw err;
  }
}

module.exports = {
  VersionedStartupError,
  authorizeVersionedFixture,
  fixtureAuthorizationAccepted,
  authorizeVersionedPersistentRoot,
  persistentAuthorizationAccepted,
  beginPersistentMigration,
  createLiveGenerationGuard,
  bootAuthorizedVersionedServer,
};
