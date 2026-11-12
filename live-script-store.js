const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeAtomic } = require('./script-library');

// Checkpoints fire in this order. A snapshot is durable only after
// temps-prepared, when pending/ is renamed to committed/. Recovery finishes
// a committed snapshot and deletes a pending one.
const LIVE_WRITE_STAGES = Object.freeze([
  'before-live',
  'temps-prepared',
  'backup-content',
  'backup-meta',
  'before-activate',
  'after-activate',
]);

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hashFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return hashBuffer(fs.readFileSync(filePath));
}

function fsyncDirectory(dirPath) {
  let fd;
  try {
    fd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    // A directory fsync is not available on every filesystem. The rename
    // itself is already atomic for a process crash.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function journalLayout(journalDir) {
  return {
    root: journalDir,
    pending: path.join(journalDir, 'pending'),
    committed: path.join(journalDir, 'committed'),
  };
}

function serializeMeta(liveId, textHash) {
  return `${JSON.stringify({ liveId: liveId || null, textHash })}\n`;
}

function readBackupMeta(metaFile, previousFile) {
  if (!fs.existsSync(metaFile)) {
    return { liveId: null, textHash: null, hasHash: false, mismatched: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  } catch (err) {
    return { liveId: null, textHash: null, hasHash: false, mismatched: true };
  }
  const liveId = parsed && typeof parsed.liveId === 'string' ? parsed.liveId : null;
  const textHash = parsed && typeof parsed.textHash === 'string' ? parsed.textHash : null;
  if (textHash && previousFile && fs.existsSync(previousFile)) {
    if (hashFile(previousFile) !== textHash) {
      return { liveId: null, textHash: null, hasHash: true, mismatched: true };
    }
  }
  return {
    liveId,
    textHash,
    hasHash: textHash !== null,
    mismatched: false,
  };
}

function replaceFile(source, dest, journalDir) {
  fs.mkdirSync(journalDir, { recursive: true });
  const tmp = path.join(journalDir, `.install-${path.basename(dest)}`);
  fs.copyFileSync(source, tmp);
  const fd = fs.openSync(tmp, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, dest);
  fsyncDirectory(path.dirname(dest));
}

function cleanInstallTemps(journalDir) {
  if (!fs.existsSync(journalDir)) return;
  fs.readdirSync(journalDir).forEach((name) => {
    if (!name.startsWith('.install-')) return;
    try { fs.unlinkSync(path.join(journalDir, name)); } catch (err) { /* Already removed. */ }
  });
}

function readReadySnapshot(snapshotDir) {
  const readyPath = path.join(snapshotDir, 'ready.json');
  if (!fs.existsSync(readyPath)) return null;
  let ready;
  try {
    ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
  } catch (err) {
    return null;
  }
  if (!ready || ready.version !== 1 || typeof ready.liveHash !== 'string') return null;
  const livePath = path.join(snapshotDir, 'live.txt');
  if (hashFile(livePath) !== ready.liveHash) return null;
  if (ready.previousHash) {
    if (typeof ready.previousHash !== 'string' || typeof ready.metaHash !== 'string') return null;
    if (hashFile(path.join(snapshotDir, 'previous.txt')) !== ready.previousHash) return null;
    if (hashFile(path.join(snapshotDir, 'meta.json')) !== ready.metaHash) return null;
  }
  return {
    dir: snapshotDir,
    liveHash: ready.liveHash,
    previousHash: ready.previousHash || null,
    metaHash: ready.metaHash || null,
  };
}

function snapshotInstalled(snapshot, paths) {
  if (hashFile(paths.scriptFile) !== snapshot.liveHash) return false;
  if (snapshot.previousHash && hashFile(paths.previousFile) !== snapshot.previousHash) return false;
  if (snapshot.metaHash && hashFile(paths.metaFile) !== snapshot.metaHash) return false;
  return true;
}

function ensureFile(snapshotDir, name, dest, expectedHash, journalDir) {
  if (!expectedHash || hashFile(dest) === expectedHash) return false;
  replaceFile(path.join(snapshotDir, name), dest, journalDir);
  return hashFile(dest) === expectedHash;
}

function applySnapshot(snapshotDir, paths, checkpoint) {
  const snapshot = readReadySnapshot(snapshotDir);
  if (!snapshot) return false;
  const point = typeof checkpoint === 'function' ? checkpoint : () => {};
  if (snapshot.previousHash) {
    ensureFile(snapshotDir, 'previous.txt', paths.previousFile, snapshot.previousHash, paths.journalDir);
    point('backup-content');
    ensureFile(snapshotDir, 'meta.json', paths.metaFile, snapshot.metaHash, paths.journalDir);
    point('backup-meta');
  } else {
    point('backup-content');
    point('backup-meta');
  }
  point('before-activate');
  ensureFile(snapshotDir, 'live.txt', paths.scriptFile, snapshot.liveHash, paths.journalDir);
  point('after-activate');
  return snapshotInstalled(snapshot, paths);
}

function removeDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function removeJournalIfEmpty(journalDir) {
  if (!fs.existsSync(journalDir)) return;
  if (fs.readdirSync(journalDir).length === 0) {
    try { fs.rmdirSync(journalDir); } catch (err) { /* Another file may have appeared. */ }
  }
}

function writeNullMeta(paths, previousText) {
  const next = serializeMeta(null, hashBuffer(Buffer.from(previousText, 'utf8')));
  if (fs.existsSync(paths.metaFile) && fs.readFileSync(paths.metaFile, 'utf8') === next) return false;
  fs.mkdirSync(paths.journalDir, { recursive: true });
  const source = path.join(paths.journalDir, 'repair-meta.json');
  writeAtomic(source, next);
  replaceFile(source, paths.metaFile, paths.journalDir);
  try { fs.unlinkSync(source); } catch (err) { /* The repair source is private and removable. */ }
  return true;
}

function repairLegacyBackup(paths) {
  const metaExists = fs.existsSync(paths.metaFile);
  if (!fs.existsSync(paths.previousFile)) {
    if (metaExists) {
      fs.unlinkSync(paths.metaFile);
      console.warn('[server] Removed script backup metadata because the backup script is missing.');
      return true;
    }
    return false;
  }
  if (!metaExists) return false;
  const previousText = fs.readFileSync(paths.previousFile, 'utf8');
  const meta = readBackupMeta(paths.metaFile, paths.previousFile);
  if (meta.mismatched) {
    writeNullMeta(paths, previousText);
    console.warn('[server] The script backup did not match its production id, so restore will not use that id.');
    return true;
  }
  // A same-production publish keeps the production id on the backup after the
  // library row itself has moved on to the new text. Only a backup that is a
  // copy of the live script, with an id for some other text, is a torn write.
  const liveText = fs.existsSync(paths.scriptFile)
    ? fs.readFileSync(paths.scriptFile, 'utf8')
    : null;
  if (
    !meta.hasHash
    && meta.liveId
    && liveText !== null
    && liveText === previousText
    && typeof paths.identityMatches === 'function'
    && !paths.identityMatches(meta.liveId, previousText)
  ) {
    writeNullMeta(paths, previousText);
    console.warn('[server] The script backup did not match its production id, so restore will not use that id.');
    return true;
  }
  return false;
}

function settleJournal(paths) {
  const layout = journalLayout(paths.journalDir);
  cleanInstallTemps(paths.journalDir);
  const repairSource = path.join(paths.journalDir, 'repair-meta.json');
  if (fs.existsSync(repairSource)) {
    try { fs.unlinkSync(repairSource); } catch (err) { /* Already removed. */ }
  }
  let scriptBefore = hashFile(paths.scriptFile);
  if (fs.existsSync(layout.committed)) {
    const snapshot = readReadySnapshot(layout.committed);
    if (!snapshot) {
      removeDir(layout.committed);
      console.warn('[server] Discarded an unreadable script save.');
    } else if (!snapshotInstalled(snapshot, paths)) {
      const applied = applySnapshot(layout.committed, paths);
      if (!applied || !snapshotInstalled(readReadySnapshot(layout.committed), paths)) {
        throw new Error('An interrupted script save could not be finished');
      }
      removeDir(layout.committed);
      console.warn('[server] Finished an interrupted script save.');
    } else {
      removeDir(layout.committed);
    }
  }
  if (fs.existsSync(layout.pending)) {
    removeDir(layout.pending);
    console.warn('[server] Discarded an incomplete script save. The live script was not changed.');
  }
  removeJournalIfEmpty(paths.journalDir);
  return { scriptChanged: scriptBefore !== hashFile(paths.scriptFile) };
}

function recoverLiveFiles(paths) {
  const settled = settleJournal(paths);
  const repaired = repairLegacyBackup(paths);
  return { scriptChanged: settled.scriptChanged, repaired };
}

function checkpoint(onStage, name) {
  if (typeof onStage === 'function') onStage(name);
}

function commitLiveFiles(paths) {
  const nextText = paths.nextText;
  if (typeof nextText !== 'string' || nextText.length === 0) {
    throw new Error('The live script text was empty');
  }
  settleJournal(paths);
  const layout = journalLayout(paths.journalDir);
  checkpoint(paths.onStage, 'before-live');

  fs.mkdirSync(layout.pending, { recursive: true });
  const liveBytes = Buffer.from(nextText, 'utf8');
  writeAtomic(path.join(layout.pending, 'live.txt'), liveBytes);
  const ready = {
    version: 1,
    liveHash: hashBuffer(liveBytes),
    previousHash: null,
    metaHash: null,
  };
  const backupText = typeof paths.nextPreviousText === 'string' && paths.nextPreviousText
    ? paths.nextPreviousText
    : '';
  if (backupText) {
    const previousBytes = Buffer.from(backupText, 'utf8');
    const metaBytes = Buffer.from(serializeMeta(paths.nextPreviousLiveId || null, hashBuffer(previousBytes)), 'utf8');
    writeAtomic(path.join(layout.pending, 'previous.txt'), previousBytes);
    writeAtomic(path.join(layout.pending, 'meta.json'), metaBytes);
    ready.previousHash = hashBuffer(previousBytes);
    ready.metaHash = hashBuffer(metaBytes);
  }
  writeAtomic(path.join(layout.pending, 'ready.json'), `${JSON.stringify(ready)}\n`);
  fsyncDirectory(layout.pending);
  checkpoint(paths.onStage, 'temps-prepared');

  fs.renameSync(layout.pending, layout.committed);
  fsyncDirectory(paths.journalDir);
  const applied = applySnapshot(layout.committed, paths, (name) => checkpoint(paths.onStage, name));
  if (!applied) throw new Error('The live script save could not be finished');
  removeDir(layout.committed);
  removeJournalIfEmpty(paths.journalDir);
  return { ok: true };
}

module.exports = {
  LIVE_WRITE_STAGES,
  journalLayout,
  readBackupMeta,
  recoverLiveFiles,
  commitLiveFiles,
};
