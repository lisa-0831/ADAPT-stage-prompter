const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { test, expect, openShow, closeShows } = require('./support');
const { startVersionedFixture } = require('./versioned-fixture');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('versioned history can be read without moving the live show', async ({ browser }) => {
  const fixture = await startVersionedFixture();
  const audience = await openShow(browser, fixture.baseURL, 'audience');

  try {
    const mirror = sha256(path.join(fixture.root, 'script.txt'));
    const liveState = sha256(path.join(fixture.libraryDir, 'live-state.json'));
    const listed = await audience.page.request.get(`${fixture.baseURL}/api/library/${fixture.liveId}/versions`);
    expect(listed.status()).toBe(200);
    const history = await listed.json();
    expect(history.order).toBe('lineage');
    expect(history.versions[0].sequence).toBeGreaterThan(0);
    const head = history.versions.find((version) => version.savedHead);
    expect(head.live).toBe(true);
    expect(head).not.toHaveProperty('description');
    const detail = await audience.page.request.get(
      `${fixture.baseURL}/api/library/${fixture.liveId}/versions/${head.versionId}`,
    );
    expect(detail.status()).toBe(200);
    const body = await detail.json();
    expect(body.version.text).toContain(fixture.spoken);
    expect(body.version.versionId).toBe(head.versionId);
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);
    expect(sha256(path.join(fixture.root, 'script.txt'))).toBe(mirror);
    expect(sha256(path.join(fixture.libraryDir, 'live-state.json'))).toBe(liveState);
  } finally {
    await closeShows([audience]);
    await fixture.close();
  }
});

test('version history stays behind the staff token on a versioned server', async ({ browser }) => {
  const fixture = await startVersionedFixture({ staffToken: 'stage-staff' });
  const controller = await openShow(browser, fixture.baseURL, 'controller');

  try {
    const missing = await controller.page.request.get(`${fixture.baseURL}/api/library/${fixture.liveId}/versions`);
    expect(missing.status()).toBe(401);
    const role = await controller.page.request.get(
      `${fixture.baseURL}/api/library/${fixture.liveId}/versions?role=controller`,
    );
    expect(role.status()).toBe(401);
    const accepted = await controller.page.request.get(
      `${fixture.baseURL}/api/library/${fixture.liveId}/versions`,
      { headers: { 'X-Staff-Token': 'stage-staff' } },
    );
    expect(accepted.status()).toBe(200);
  } finally {
    await closeShows([controller]);
    await fixture.close();
  }
});
