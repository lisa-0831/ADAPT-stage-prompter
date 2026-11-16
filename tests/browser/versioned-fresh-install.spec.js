const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPrompterServer } = require('../../server');
const { freshInstallationBytes } = require('../../server/storage-mode');
const { authorizeVersionedFixture } = require('../../server/versioned-runtime');
const { test, expect, openShow, closeShows } = require('./support');

const INSTALLATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STALE = 'STALE MIRROR MUST NOT APPEAR\n';
const SCRIPT = '# Opening\n[ADA]\nFIRST CUE\n';

async function startFresh(options) {
  const settings = options || {};
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-fresh-browser-')));
  const libraryDir = path.join(root, 'data', 'library');
  const journalDir = path.join(root, 'data', 'live-journal');
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.mkdirSync(journalDir, { recursive: true });
  const scriptFile = path.join(root, 'script.txt');
  const previousFile = path.join(root, 'script.previous.txt');
  fs.writeFileSync(scriptFile, STALE);
  fs.writeFileSync(previousFile, '');
  fs.writeFileSync(`${previousFile}.meta.json`, '{}\n');
  fs.writeFileSync(path.join(libraryDir, 'migration.json'), freshInstallationBytes(INSTALLATION, false));
  const paths = { root, libraryDir, scriptFile, previousFile, journalDir };
  let current = null;
  let closed = false;

  async function boot() {
    const server = await createPrompterServer({
      scriptFile,
      previousFile,
      libraryDir,
      journalDir,
      staffToken: '',
      versionedFixture: authorizeVersionedFixture(paths),
      now: () => '2026-06-06T00:00:00.000Z',
    });
    await new Promise((resolve, reject) => {
      server.server.once('error', reject);
      server.server.listen(0, '127.0.0.1', resolve);
    });
    current = server;
    return `http://127.0.0.1:${server.server.address().port}`;
  }

  const baseURL = await boot();
  return {
    baseURL,
    root,
    libraryDir,
    scriptFile,
    async restart() {
      for (const client of current.wss.clients) client.terminate();
      await current.close();
      current = null;
      this.baseURL = await boot();
      return this.baseURL;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (current) {
        for (const client of current.wss.clients) client.terminate();
        await current.close();
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('a fresh library waits, then the first Set as Live reaches every screen', async ({ browser }) => {
  const fixture = await startFresh();
  const controller = await openShow(browser, fixture.baseURL, 'controller');
  const actor = await openShow(browser, fixture.baseURL, 'actor');
  const audience = await openShow(browser, fixture.baseURL, 'audience');

  try {
    await expect(controller.page.locator('#waiting-show-title')).toHaveText('The performance script has not been loaded yet.');
    await expect(actor.page.locator('#waiting-show-title')).toHaveText('The performance script has not been loaded yet.');
    await expect(audience.page.locator('#waiting-show-title')).toHaveText('The performance script has not been loaded yet.');
    await expect(controller.page.locator('#waiting-show-setup')).toBeVisible();
    await expect(audience.page.locator('#waiting-show-setup')).toBeHidden();
    await expect(actor.page.locator('#actor-controls')).toBeVisible();
    await expect(actor.page.locator('#controller')).toBeHidden();
    await expect(audience.page.locator('#controller')).toBeHidden();
    await expect(controller.page.locator('#btn-edit-script')).toBeDisabled();
    await expect(controller.page.locator('body')).not.toContainText('STALE MIRROR');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveCount(0);

    const posts = [];
    controller.page.on('request', (request) => {
      if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
    });
    await controller.page.locator('#btn-script-library').click();
    await controller.page.locator('#library-create-open').click();
    await controller.page.locator('#library-create-script').setInputFiles({
      name: 'opening.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(SCRIPT),
    });
    expect(posts).toEqual([]);
    expect(fs.existsSync(path.join(fixture.libraryDir, 'productions'))).toBe(false);
    await controller.page.locator('#library-create-name').fill('Opening Night');
    await controller.page.locator('#library-create-submit').click();
    await expect(controller.page.locator('#library-create-status')).toContainText('not the live show');
    await controller.page.locator('#library-create-cancel').click();
    await expect(controller.page.locator('#waiting-show')).toBeVisible();
    await expect(audience.page.locator('#waiting-show')).toBeVisible();
    expect(fs.existsSync(path.join(fixture.libraryDir, 'live-state.json'))).toBe(false);

    await controller.page.getByRole('button', { name: 'Set as Live Opening Night' }).click();
    await expect(controller.page.locator('#library-confirm-body')).toContainText('No script is live yet');
    await controller.page.locator('#library-confirm-yes').click();
    await expect(controller.page.locator('#lines-current .script-line')).toHaveText('FIRST CUE');
    await expect(actor.page.locator('#lines-current .script-line')).toHaveText('FIRST CUE');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText('FIRST CUE');
    await expect(controller.page.locator('#waiting-show')).toBeHidden();
    const live = JSON.parse(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'), 'utf8'));
    expect(live.generation).toBe(1);
    expect(live.previousActivation).toBeNull();
    expect(fs.readFileSync(fixture.scriptFile, 'utf8')).toBe(SCRIPT);

    const restarted = await fixture.restart();
    const late = await openShow(browser, restarted, 'audience');
    await expect(late.page.locator('#lines-current .script-line')).toHaveText('FIRST CUE');
    await expect(late.page.locator('#waiting-show')).toBeHidden();
    await closeShows([late]);
  } finally {
    await closeShows([controller, actor, audience]);
    await fixture.close();
  }
});
