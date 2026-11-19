'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isPersistentRootRetained } = require('./persistent-authorization');

const REPO_ROOT = path.resolve(__dirname, '..');

function inside(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function assessWritableRoot(rootReal) {
  const repoReal = fs.realpathSync(REPO_ROOT);
  if (rootReal === repoReal || inside(rootReal, repoReal) || inside(repoReal, rootReal)) {
    return { ok: false, code: 'unsafe-root' };
  }
  if (isPersistentRootRetained(rootReal)) {
    return { ok: true, kind: 'persistent', rootReal };
  }
  const tmpReal = fs.realpathSync(os.tmpdir());
  if (rootReal !== tmpReal && inside(rootReal, tmpReal)) {
    return { ok: true, kind: 'fixture', rootReal };
  }
  return { ok: false, code: 'unsafe-root' };
}

module.exports = {
  assessWritableRoot,
};
