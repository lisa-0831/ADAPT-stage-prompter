'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { verifyVersionedSeed } = require('../../scripts/versioned-seed');

const RUNTIME = [
  'data/library/migration.json',
  'data/library/migration-attempt.json',
  'data/library/live-state.json',
  'data/library/.writer.lock',
  'data/library/migration-work',
  'data/live-journal',
];

function assertCheckoutSeedIntact(repoRoot) {
  const checked = verifyVersionedSeed(repoRoot);
  assert.equal(checked.ok, true, checked.error);
  RUNTIME.forEach((relative) => {
    assert.equal(fs.existsSync(path.join(repoRoot, ...relative.split('/'))), false, relative);
  });
  return checked.seed;
}

module.exports = { assertCheckoutSeedIntact };
