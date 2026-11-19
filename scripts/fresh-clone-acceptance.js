'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { protectedRoots } = require('./install-paths');

const repo = path.resolve(__dirname, '..');
const welcome = '2d0f0937-fc36-4d27-a31e-d047c2fd5623';

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, options));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stderr}`));
    });
  });
}

function eligibleFiles() {
  const tracked = spawn('git', ['ls-files', '-z'], { cwd: repo });
  const untracked = spawn('git', ['ls-files', '-z', '-o', '--exclude-standard'], { cwd: repo });
  function read(child) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let stderr = '';
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('exit', (code) => {
        if (code !== 0) reject(new Error(stderr));
        else resolve(Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean));
      });
    });
  }
  return Promise.all([read(tracked), read(untracked)]).then((lists) => {
    return Array.from(new Set(lists[0].concat(lists[1]))).sort();
  });
}

function request(port, method, route, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: route,
      headers: Object.assign(body ? { 'Content-Type': 'application/json' } : {}, headers || {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let parsed = raw.toString('utf8');
        try { parsed = JSON.parse(parsed); } catch (err) { /* Keep text responses as strings. */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function startServer(clone, home) {
  const child = spawn(process.execPath, [path.join(clone, 'scripts', 'start-installed.js')], {
    cwd: clone,
    env: Object.assign({}, process.env, {
      ADAPT_PROMPTER_HOME: home,
      ADAPT_PROMPTER_DATA: '',
      ADAPT_PROMPTER_CONFIG: '',
      ADAPT_PROMPTER_BACKUP: '',
      PORT: '0',
      PROMPTER_STAFF_TOKEN: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`start timed out\n${stdout}\n${stderr}`)), 60000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const line = stdout.indexOf('\n');
      if (line < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(stdout.slice(0, line)));
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => {
      if (stdout.includes('\n')) return;
      clearTimeout(timer);
      reject(new Error(`start exited ${code}\n${stderr}`));
    });
  });
  return { child, ready };
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGINT');
  });
}

function entryCount(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).length;
}

async function browserCheck(port) {
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const base = `http://127.0.0.1:${port}`;
  async function open(role) {
    const context = await browser.newContext({
      reducedMotion: 'reduce',
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`${base}/?role=${role}`);
    await page.locator('#connecting').waitFor({ state: 'hidden' });
    return { context, page, errors };
  }
  const controller = await open('controller');
  const audience = await open('audience');
  const actor = await open('actor');
  const stageText = (page) => page.locator('#stage-content').innerText();
  const before = await stageText(audience.page);
  await controller.page.locator('#btn-next').click();
  await audience.page.waitForFunction((previous) => {
    const stage = document.querySelector('#stage-content');
    return stage && stage.innerText !== previous;
  }, before);
  const moved = await stageText(audience.page);
  if (moved === before) throw new Error('Audience did not follow the controller.');
  await actor.page.locator('#btn-actor-next').click();
  await actor.page.locator('#actor-mode-status').filter({ hasText: 'BROWSING' }).waitFor();
  const audienceWhileBrowsing = await stageText(audience.page);
  if (audienceWhileBrowsing !== moved) throw new Error('Actor browsing moved the audience.');
  await actor.page.locator('#btn-return-live').click();
  await actor.page.locator('#actor-mode-status').filter({ hasText: 'FOLLOWING LIVE' }).waitFor();
  await controller.page.locator('#btn-script-library').click();
  await controller.page.locator('#script-library').waitFor({ state: 'visible' });
  await controller.page.locator('#library-list').getByText('WELCOME', { exact: false }).waitFor();
  if (await controller.page.locator('#library-list').getByText('Test', { exact: true }).count()) {
    throw new Error('The library still lists Test.');
  }
  [controller, audience, actor].forEach((entry) => {
    if (entry.errors.length) throw new Error(entry.errors.join('\n'));
  });
  await browser.close();
}

async function main() {
  // send() refuses a page path that contains a dot directory, so this
  // checkout copy stays in the system temp directory rather than a home folder.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-fresh-clone-'));
  const clone = path.join(parent, 'clone');
  const home = path.join(parent, 'home');
  const support = path.join(os.homedir(), 'Library', 'Application Support', 'ADAPT Stage Prompter');
  const supportBefore = fs.existsSync(support) ? fs.statSync(support).mtimeMs : null;
  const protectedBefore = new Map(protectedRoots().map((root) => [root, entryCount(root)]));
  const files = await eligibleFiles();
  fs.mkdirSync(clone, { recursive: true });
  files.forEach((relative) => {
    const from = path.join(repo, ...relative.split('/'));
    const to = path.join(clone, ...relative.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  });
  const productions = path.join(clone, 'data', 'library', 'productions');
  if (!fs.existsSync(path.join(productions, welcome, 'metadata.json'))) {
    throw new Error('The clone does not contain WELCOME before startup.');
  }
  if (!fs.existsSync(path.join(clone, 'data', 'library', 'seed.json'))) {
    throw new Error('The clone does not contain the seed catalog before startup.');
  }
  ['migration.json', 'live-state.json', '.writer.lock'].forEach((name) => {
    if (fs.existsSync(path.join(clone, 'data', 'library', name))) {
      throw new Error(`The clone contains runtime file ${name} before startup.`);
    }
  });
  await run('npm', ['install', '--ignore-scripts'], { cwd: clone });
  const first = startServer(clone, home);
  let started;
  try {
  started = await first.ready;
  if (!started.ok || started.host !== '127.0.0.1') throw new Error(JSON.stringify(started));
  const listed = await request(started.port, 'GET', '/api/library');
  if (listed.status !== 200 || listed.body.liveId !== welcome) {
    throw new Error(`Initial library was not WELCOME: ${JSON.stringify(listed.body)}`);
  }
  const titles = listed.body.scripts.map((script) => script.title);
  if (titles.length !== 1 || !titles[0].startsWith('WELCOME')) {
    throw new Error(`Unexpected productions: ${titles.join(', ')}`);
  }
  const version = await request(started.port, 'GET', `/api/library/${welcome}/versions/ec466c0e-e4dc-451e-a80d-b80a29c9b945`);
  if (version.status !== 200 || version.body.version.parentVersionId !== '5d7e83b1-d687-4195-8bcd-c69fd5a42e69') {
    throw new Error(`Version parent was not preserved: ${JSON.stringify(version.body)}`);
  }
  const image = await request(started.port, 'GET', `/api/live/assets/${welcome}/fc7b02fc-c40d-4b80-9797-917385e0cba2`);
  if (image.status !== 200 || image.raw.length < 1000) throw new Error(`Live image status ${image.status}`);
  await browserCheck(started.port);
  const title = `Fresh clone ${crypto.randomBytes(4).toString('hex')}`;
  const created = await request(started.port, 'POST', '/api/library', JSON.stringify({
    title,
    text: '# Fresh Clone\n[ADA]\nFIRST DRAFT\n',
  }));
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  const edited = '# Fresh Clone\n[ADA]\nSAVED AFTER RESTART\n';
  const saved = await request(started.port, 'PUT', `/api/library/${created.body.script.id}`, JSON.stringify({
    text: edited,
    expectedRevision: created.body.script.revision,
  }));
  if (saved.status !== 200) throw new Error(JSON.stringify(saved.body));
  const published = await request(started.port, 'POST', `/api/library/${created.body.script.id}/live`, JSON.stringify({
    expectedRevision: saved.body.script.revision,
  }));
  if (published.status !== 200) throw new Error(JSON.stringify(published.body));
  const marker = fs.readFileSync(path.join(home, 'library', 'data', 'library', 'migration.json'));
  await stopServer(first.child);

  const second = startServer(clone, home);
  const secondReady = await second.ready;
  const after = await request(secondReady.port, 'GET', '/api/library');
  if (!after.body.scripts.some((script) => script.id === created.body.script.id && script.title === title)) {
    throw new Error('The saved production did not survive the first restart.');
  }
  if (after.body.liveId !== created.body.script.id) throw new Error('Live state did not survive the first restart.');
  const live = await request(secondReady.port, 'GET', '/script');
  if (!String(live.raw).includes('SAVED AFTER RESTART')) throw new Error('Published text did not survive the restart.');
  await stopServer(second.child);

  const third = startServer(clone, home);
  const thirdReady = await third.ready;
  const still = await request(thirdReady.port, 'GET', '/api/library');
  if (still.body.liveId !== created.body.script.id) throw new Error('The third start did not reuse the library.');
  if (!fs.readFileSync(path.join(home, 'library', 'data', 'library', 'migration.json')).equals(marker)) {
    throw new Error('The third start rewrote the installation marker.');
  }
  await stopServer(third.child);

  if (fs.existsSync(path.join(clone, 'data', 'library', 'migration.json'))) {
    throw new Error('Startup wrote a marker into the clone.');
  }
  if (fs.existsSync(path.join(repo, 'data', 'library', 'migration.json'))) {
    throw new Error('Startup wrote a marker into the original checkout.');
  }
  protectedBefore.forEach((count, root) => {
    if (entryCount(root) !== count) throw new Error(`Protected directory changed: ${root}`);
  });
  if (supportBefore === null && fs.existsSync(support)) throw new Error('Startup created the default Application Support directory.');
  if (supportBefore !== null && fs.statSync(support).mtimeMs !== supportBefore) {
    throw new Error('Startup changed the existing Application Support directory.');
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    cloneFiles: files.length,
    host: started.host,
    port: started.port,
    liveAfterRestart: still.body.liveId,
    productions: still.body.scripts.map((script) => script.title),
  })}\n`);
  } finally {
    await stopServer(first.child);
  }
}

main().catch((err) => {
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
