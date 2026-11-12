const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPrompterServer } = require('../server');

const SPOKEN = 'FIRST SPOKEN LINE';
const TAIL = 'LAST SPOKEN LINE';
const BLUE = 'BLUE ROOM LINE';
const LIVE_TITLE = 'Stage Fixture';
const OTHER_TITLE = 'Blue Room';

// 1x1 PNG. Generated here so the suite never writes into images/.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function assertDisposable(dir) {
  const resolved = path.resolve(dir);
  const repo = path.resolve(__dirname, '..');
  const tmp = path.resolve(os.tmpdir());
  if (resolved === repo || resolved.startsWith(`${repo}${path.sep}`)) {
    throw new Error(`Refusing to use a repository path for test data: ${resolved}`);
  }
  if (resolved !== tmp && !resolved.startsWith(`${tmp}${path.sep}`)) {
    throw new Error(`Refusing to use a path outside the temp directory: ${resolved}`);
  }
}

function stageScript(scriptId, assetId) {
  const image = `library:${scriptId.toLowerCase()}/${assetId.toLowerCase()}`;
  return [
    '# Opening',
    `@image: ${image}`,
    '[ADA]',
    SPOKEN,
    '',
    '---',
    '# Picture A',
    `@image: ${image}`,
    '',
    '---',
    '# Picture B',
    `@image: ${image}`,
    '',
    '---',
    '# Gap',
    '',
    '---',
    '# Tail',
    '[ADA]',
    TAIL,
    '',
  ].join('\n');
}

async function readJson(response) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (err) { body = null; }
  if (!response.ok) {
    throw new Error(`Fixture request failed (${response.status}): ${text}`);
  }
  return body;
}

async function startFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-browser-'));
  assertDisposable(dir);
  const scriptFile = path.join(dir, 'script.txt');
  const previousFile = path.join(dir, 'script.previous.txt');
  const libraryDir = path.join(dir, 'library');
  const journalDir = path.join(dir, 'live-journal');
  const repoScript = path.join(__dirname, '..', 'script.txt');
  const repoScriptHash = crypto.createHash('sha256').update(fs.readFileSync(repoScript)).digest('hex');

  fs.writeFileSync(scriptFile, '# Bootstrap Holder\n[BOOT]\nBoot line\n');
  const created = createPrompterServer({
    scriptFile,
    previousFile,
    libraryDir,
    journalDir,
  });
  let closed = false;

  async function close() {
    if (closed) return;
    closed = true;
    for (const client of created.wss.clients) client.terminate();
    await new Promise((resolve) => created.wss.close(() => resolve()));
    await new Promise((resolve) => created.server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
    const after = crypto.createHash('sha256').update(fs.readFileSync(repoScript)).digest('hex');
    if (after !== repoScriptHash) {
      throw new Error('Browser fixture changed the repository script.txt');
    }
  }

  try {
    await new Promise((resolve, reject) => {
      created.server.once('error', reject);
      created.server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = created.server.address();
    const baseURL = `http://127.0.0.1:${port}`;

    const createdScript = await readJson(await fetch(`${baseURL}/api/library`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: LIVE_TITLE,
        text: '# Opening\n[ADA]\nPlaceholder line\n',
      }),
    }));
    const scriptId = createdScript.script.id;
    const uploaded = await readJson(await fetch(`${baseURL}/api/library/${scriptId}/assets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Asset-Name': encodeURIComponent('card.png'),
      },
      body: PNG,
    }));
    const updated = await readJson(await fetch(`${baseURL}/api/library/${scriptId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: stageScript(scriptId, uploaded.asset.id),
        expectedRevision: createdScript.script.revision,
      }),
    }));
    await readJson(await fetch(`${baseURL}/api/library/${scriptId}/live`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: updated.script.revision }),
    }));
    await readJson(await fetch(`${baseURL}/api/library`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: OTHER_TITLE,
        text: '# Blue Room\n[BLUE]\nBLUE ROOM LINE\n',
      }),
    }));

    return {
      baseURL,
      close,
      spoken: SPOKEN,
      tail: TAIL,
      blue: BLUE,
      liveTitle: LIVE_TITLE,
      otherTitle: OTHER_TITLE,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

module.exports = { startFixture };
