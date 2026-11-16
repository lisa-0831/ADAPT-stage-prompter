const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPrompterServer } = require('../../server');
const { runMigration } = require('../../library-migration-cli');
const { authorizeVersionedFixture } = require('../../server/versioned-runtime');

const repoRoot = path.resolve(__dirname, '..', '..');
const LIVE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const LIVE_TITLE = 'Stage Fixture';
const OTHER_TITLE = 'Blue Room';
const SPOKEN = 'FIRST SPOKEN LINE';
const MIDDLE = 'MIDDLE CUE FOR THE LONG WRAPPED SENTENCE THAT STAYS ON THIS LINE';
const TAIL = 'LAST SPOKEN LINE';
const BLUE = 'BLUE ROOM LINE';
const DIRECTION = 'She looks up.';

function liveText() {
  return [
    '# Opening',
    '[ADA]',
    SPOKEN,
    '',
    '---',
    '# Middle',
    `{${DIRECTION}}`,
    MIDDLE,
    '',
    '---',
    '# Tail',
    '[ADA]',
    TAIL,
    '',
  ].join('\n');
}

function otherText() {
  return `# Blue Room\n[BLUE]\n${BLUE}\n`;
}

function assertDisposable(dir) {
  const resolved = fs.realpathSync(dir);
  const repo = fs.realpathSync(repoRoot);
  const tmp = fs.realpathSync(os.tmpdir());
  if (resolved === repo || resolved.startsWith(`${repo}${path.sep}`)) {
    throw new Error(`Refusing to use a repository path for test data: ${resolved}`);
  }
  if (resolved === tmp || !resolved.startsWith(`${tmp}${path.sep}`)) {
    throw new Error(`Refusing to use a path outside the temp directory: ${resolved}`);
  }
  return resolved;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function idFactory(prefix) {
  let count = 0;
  return () => {
    count += 1;
    return `${prefix}-aaaa-4aaa-8aaa-${count.toString(16).padStart(12, '0')}`;
  };
}

function clock() {
  let tick = 0;
  return () => {
    const value = new Date(Date.UTC(2026, 5, 6, 0, 0, tick)).toISOString();
    tick += 1;
    return value;
  };
}

async function startVersionedFixture(options) {
  const settings = options || {};
  const root = assertDisposable(fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-versioned-browser-')));
  const libraryDir = path.join(root, 'data', 'library');
  const text = liveText();
  const saved = otherText();
  fs.mkdirSync(path.join(libraryDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(libraryDir, 'scripts', `${LIVE}.txt`), text);
  fs.writeFileSync(path.join(libraryDir, 'scripts', `${OTHER}.txt`), saved);
  fs.writeFileSync(path.join(root, 'script.txt'), text);
  fs.writeFileSync(path.join(root, 'script.previous.txt'), 'previous-live\n');
  writeJson(path.join(root, 'script.previous.txt.meta.json'), {
    liveId: null,
    textHash: 'ab'.repeat(32),
  });
  writeJson(path.join(libraryDir, 'index.json'), {
    version: 1,
    liveId: LIVE,
    scripts: [LIVE, OTHER].map((id, index) => ({
      id,
      title: index === 0 ? LIVE_TITLE : OTHER_TITLE,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      revision: sha256(Buffer.from(index === 0 ? text : saved)),
    })),
  });
  const prepared = runMigration({
    command: 'prepare',
    root,
    createId: idFactory('cccccccc'),
    now: () => '2026-06-06T00:00:00.000Z',
  });
  if (!prepared.ok) throw new Error(prepared.error || 'The versioned fixture could not be prepared.');
  const committed = runMigration({
    command: 'commit',
    root,
    createId: () => { throw new Error('unexpected id'); },
  });
  if (!committed.ok) throw new Error(committed.error || 'The versioned fixture could not be committed.');
  const paths = {
    root,
    libraryDir,
    scriptFile: path.join(root, 'script.txt'),
    previousFile: path.join(root, 'script.previous.txt'),
    journalDir: path.join(root, 'data', 'live-journal'),
  };
  const repoScript = fs.readFileSync(path.join(repoRoot, 'script.txt'));
  const now = clock();
  let current = null;
  let closed = false;

  async function boot() {
    const server = await createPrompterServer({
      scriptFile: paths.scriptFile,
      previousFile: paths.previousFile,
      libraryDir: paths.libraryDir,
      journalDir: paths.journalDir,
      staffToken: settings.staffToken || '',
      versionedFixture: authorizeVersionedFixture(paths),
      now,
      createId: idFactory('dddddddd'),
      failSynchronization: settings.failSynchronization,
    });
    await new Promise((resolve, reject) => {
      server.server.once('error', reject);
      server.server.listen(0, '127.0.0.1', resolve);
    });
    current = server;
    return `http://127.0.0.1:${server.server.address().port}`;
  }

  async function shutdown() {
    if (!current) return;
    const server = current;
    current = null;
    for (const client of server.wss.clients) client.terminate();
    await server.close();
  }

  const baseURL = await boot();
  return {
    baseURL,
    root,
    libraryDir,
    paths,
    spoken: SPOKEN,
    middle: MIDDLE,
    direction: DIRECTION,
    tail: TAIL,
    blue: BLUE,
    liveTitle: LIVE_TITLE,
    otherTitle: OTHER_TITLE,
    liveId: LIVE,
    otherId: OTHER,
    async restart() {
      await shutdown();
      this.baseURL = await boot();
      return this.baseURL;
    },
    async close() {
      if (closed) return;
      closed = true;
      await shutdown();
      fs.rmSync(root, { recursive: true, force: true });
      const after = fs.readFileSync(path.join(repoRoot, 'script.txt'));
      if (!after.equals(repoScript)) throw new Error('Versioned browser fixture changed the repository script.txt');
    },
  };
}

module.exports = { startVersionedFixture };
