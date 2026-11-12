const { test, expect, openShow, assertQuiet, closeShows } = require('./support');

test('each role shows only its own controls', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const actor = await openShow(browser, prompter.baseURL, 'actor');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const missing = await openShow(browser, prompter.baseURL, null);
  const invalid = await openShow(browser, prompter.baseURL, 'nope');
  const pages = [controller, actor, audience, missing, invalid];

  try {
    await expect(controller.page.locator('html')).toHaveAttribute('data-role', 'controller');
    await expect(controller.page.locator('#controller')).toBeVisible();
    await expect(controller.page.locator('#btn-next')).toBeVisible();
    await expect(controller.page.locator('#btn-prev')).toBeVisible();
    await expect(controller.page.locator('#btn-edit-script')).toBeVisible();
    await expect(controller.page.locator('#btn-script-library')).toBeVisible();
    await expect(controller.page.locator('#actor-controls')).toBeHidden();

    await expect(actor.page.locator('html')).toHaveAttribute('data-role', 'actor');
    await expect(actor.page.locator('#actor-controls')).toBeVisible();
    await expect(actor.page.getByRole('button', { name: 'Previous script cue' })).toBeVisible();
    await expect(actor.page.getByRole('button', { name: 'Next script cue' })).toBeVisible();
    await expect(actor.page.getByRole('button', { name: 'Return to the live Controller position' })).toBeVisible();
    await expect(actor.page.locator('#controller')).toBeHidden();

    for (const entry of [audience, missing, invalid]) {
      await expect(entry.page.locator('html')).toHaveAttribute('data-role', 'audience');
      await expect(entry.page.locator('#role-label')).toHaveText('AUDIENCE');
      await expect(entry.page.locator('#controller')).toBeHidden();
      await expect(entry.page.locator('#actor-controls')).toBeHidden();
      await expect(entry.page.locator('#btn-next')).toBeHidden();
      await expect(entry.page.locator('#btn-actor-next')).toBeHidden();
    }

    const stylesheet = await controller.page.request.get(`${prompter.baseURL}/styles.css`);
    expect(stylesheet.status()).toBe(200);
    expect(stylesheet.headers()['content-type'] || '').toMatch(/css/);
    const css = await stylesheet.text();
    const assetUrls = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((match) => match[2]);
    expect(assetUrls.length).toBeGreaterThan(0);
    for (const assetUrl of assetUrls) {
      const resolved = new URL(assetUrl, `${prompter.baseURL}/styles.css`);
      const asset = await controller.page.request.get(resolved.toString());
      expect(asset.status(), assetUrl).toBe(200);
    }

    const textScript = await controller.page.request.get(`${prompter.baseURL}/public/text.js`);
    expect(textScript.status()).toBe(200);
    expect(textScript.headers()['content-type'] || '').toMatch(/javascript/);
    const liveShowScript = await controller.page.request.get(`${prompter.baseURL}/public/live-show.js`);
    expect(liveShowScript.status()).toBe(200);
    expect(liveShowScript.headers()['content-type'] || '').toMatch(/javascript/);
    const stageScript = await controller.page.request.get(`${prompter.baseURL}/public/stage.js`);
    expect(stageScript.status()).toBe(200);
    expect(stageScript.headers()['content-type'] || '').toMatch(/javascript/);
    const actorScript = await controller.page.request.get(`${prompter.baseURL}/public/actor-view.js`);
    expect(actorScript.status()).toBe(200);
    expect(actorScript.headers()['content-type'] || '').toMatch(/javascript/);
    const connectionScript = await controller.page.request.get(`${prompter.baseURL}/public/connection.js`);
    expect(connectionScript.status()).toBe(200);
    expect(connectionScript.headers()['content-type'] || '').toMatch(/javascript/);
    const controllerScript = await controller.page.request.get(`${prompter.baseURL}/public/controller-view.js`);
    expect(controllerScript.status()).toBe(200);
    expect(controllerScript.headers()['content-type'] || '').toMatch(/javascript/);
    const replaceScript = await controller.page.request.get(`${prompter.baseURL}/public/replace-script.js`);
    expect(replaceScript.status()).toBe(200);
    expect(replaceScript.headers()['content-type'] || '').toMatch(/javascript/);
    const exitScript = await controller.page.request.get(`${prompter.baseURL}/public/exit-confirmation.js`);
    expect(exitScript.status()).toBe(200);
    expect(exitScript.headers()['content-type'] || '').toMatch(/javascript/);

    for (const entry of [controller, actor, audience]) {
      await expect(entry.page.locator('link[rel="stylesheet"]')).toHaveAttribute('href', '/styles.css');
      await expect(entry.page.locator('style')).toHaveCount(0);
      await expect(entry.page.locator('script[src="public/text.js"]')).toHaveCount(1);
      await expect(entry.page.locator('script[src="public/live-show.js"]')).toHaveCount(1);
      await expect(entry.page.locator('script[src="public/stage.js"]')).toHaveCount(1);
      await expect(entry.page.locator('script[src="public/actor-view.js"]')).toHaveCount(1);
      await expect(entry.page.locator('script[src="public/connection.js"]')).toHaveCount(1);
      await expect(entry.page.locator('script[src="public/controller-view.js"]')).toHaveCount(1);
      await expect(entry.page.locator('script[src="public/replace-script.js"]')).toHaveCount(1);
      await expect(entry.page.locator('script[src="public/exit-confirmation.js"]')).toHaveCount(1);
      const classified = await entry.page.evaluate(() => ({
        dialogue: PrompterText.lineType('HELLO THERE'),
        direction: PrompterText.lineType('  {She exits.}'),
        lyric: PrompterText.lineType('## Somewhere'),
        singalong: PrompterText.lineType('< Follow along >'),
        plain: PrompterText.displayText('  HELLO  ', 'dialogue'),
        directionText: PrompterText.displayText('  {She exits.}', 'direction'),
        lyricText: PrompterText.displayText('## Somewhere ##', 'lyric'),
        singalongText: PrompterText.displayText('< Follow along >', 'singalong'),
      }));
      expect(classified).toEqual({
        dialogue: 'dialogue',
        direction: 'direction',
        lyric: 'lyric',
        singalong: 'singalong',
        plain: '  HELLO  ',
        directionText: 'She exits.',
        lyricText: 'Somewhere',
        singalongText: 'Follow along',
      });
      const stageApi = await entry.page.evaluate(() => ({
        legacy: PrompterStage.imageUrl('images/Title_Card.jpeg'),
        library: PrompterStage.imageUrl(
          'library:11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222',
        ),
        empty: PrompterStage.imageUrl(''),
        canRender: typeof PrompterStage.render,
        canRebuild: typeof PrompterStage.rebuildSlideSelect,
      }));
      expect(stageApi).toEqual({
        legacy: 'images/Title_Card.jpeg',
        library: '/api/live/assets/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222',
        empty: '',
        canRender: 'function',
        canRebuild: 'function',
      });
      await expect.poll(() => entry.page.evaluate(() => {
        const slides = PrompterLiveShow.getSlides();
        const state = PrompterLiveShow.getLiveState();
        return {
          sameSlides: slides === PrompterLiveShow.getSlides(),
          slideCount: Array.isArray(slides) ? slides.length : 0,
          hasState: Boolean(state && Number.isInteger(state.slideIndex)),
          revision: typeof PrompterLiveShow.getRevision(),
          liveScriptId: typeof PrompterLiveShow.getLiveScriptId(),
        };
      })).toEqual({
        sameSlides: true,
        slideCount: 5,
        hasState: true,
        revision: 'string',
        liveScriptId: 'string',
      });
      await expect.poll(() => entry.page.evaluate(() => PrompterConnection.getStatus())).toEqual({
        status: 'connected',
        waitingForLiveState: false,
      });
      const controllerEnabled = await entry.page.evaluate(() => PrompterController.isEnabled());
      expect(controllerEnabled).toBe(entry.page === controller.page);
      const exitEnabled = await entry.page.evaluate(() => PrompterExitConfirmation.isEnabled());
      expect(exitEnabled).toBe(entry.page === controller.page);
      if (entry.page === actor.page) {
        const aligned = await entry.page.evaluate(() => {
          const live = PrompterLiveShow.getLiveState();
          const shown = PrompterActor.effectivePosition();
          return Boolean(
            live
            && shown
            && shown.slideIndex === live.slideIndex
            && shown.lineIndex === live.lineIndex,
          );
        });
        expect(aligned).toBe(true);
      }
      const applied = await entry.page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const body = getComputedStyle(document.body);
        const stage = getComputedStyle(document.getElementById('stage'));
        return {
          caption: root.getPropertyValue('--caption-size').trim(),
          background: body.backgroundColor,
          stageImage: stage.backgroundImage,
        };
      });
      expect(applied.caption).toContain('clamp');
      expect(applied.background).toBe('rgb(10, 10, 10)');
      expect(applied.stageImage).toContain('background.jpg');
    }

    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});
