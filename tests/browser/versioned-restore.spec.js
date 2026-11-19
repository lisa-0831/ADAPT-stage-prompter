const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { test, expect, openShow, closeShows } = require('./support');
const { startVersionedFixture } = require('./versioned-fixture');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('restoring a saved version leaves the live show on its current line', async ({ browser }) => {
  const fixture = await startVersionedFixture();
  const audience = await openShow(browser, fixture.baseURL, 'audience');
  const restoredId = '66666666-6666-4666-8666-666666666666';
  const editedId = '55555555-5555-4555-8555-555555555555';

  try {
    const mirror = sha256(path.join(fixture.root, 'script.txt'));
    const liveState = sha256(path.join(fixture.libraryDir, 'live-state.json'));
    const listed = await audience.page.request.get(`${fixture.baseURL}/api/library/${fixture.liveId}/versions`);
    expect(listed.status()).toBe(200);
    const history = await listed.json();
    const head = history.versions.find((version) => version.savedHead);
    const saved = await audience.page.request.put(`${fixture.baseURL}/api/library/${fixture.liveId}`, {
      headers: { 'X-Version-Id': editedId },
      data: {
        text: '# Opening\n[ADA]\nEDITED AND NOT LIVE\n',
        expectedRevision: head.contentHash,
      },
    });
    expect(saved.status()).toBe(200);
    const restored = await audience.page.request.post(
      `${fixture.baseURL}/api/library/${fixture.liveId}/versions/${head.versionId}/restore`,
      {
        headers: { 'X-Version-Id': restoredId },
        data: { expectedVersionId: editedId },
      },
    );
    expect(restored.status()).toBe(201);
    const body = await restored.json();
    expect(body.sourceVersionId).toBe(head.versionId);
    expect(body.parentVersionId).toBe(editedId);
    expect(body.savedHeadVersionId).toBe(restoredId);
    expect(body.version).not.toHaveProperty('sourceVersionId');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);
    expect(sha256(path.join(fixture.root, 'script.txt'))).toBe(mirror);
    expect(sha256(path.join(fixture.libraryDir, 'live-state.json'))).toBe(liveState);
  } finally {
    await closeShows([audience]);
    await fixture.close();
  }
});

test('restore stays behind the staff token', async ({ browser }) => {
  const fixture = await startVersionedFixture({ staffToken: 'stage-staff' });
  const controller = await openShow(browser, fixture.baseURL, 'controller');

  try {
    const listed = await controller.page.request.get(`${fixture.baseURL}/api/library/${fixture.liveId}/versions`, {
      headers: { 'X-Staff-Token': 'stage-staff' },
    });
    expect(listed.status()).toBe(200);
    const history = await listed.json();
    const head = history.versions.find((version) => version.savedHead);
    const missing = await controller.page.request.post(
      `${fixture.baseURL}/api/library/${fixture.liveId}/versions/${head.versionId}/restore`,
      { data: { expectedVersionId: head.versionId } },
    );
    expect(missing.status()).toBe(401);
    const role = await controller.page.request.post(
      `${fixture.baseURL}/api/library/${fixture.liveId}/versions/${head.versionId}/restore?role=controller`,
      {
        headers: { 'X-Version-Id': '66666666-6666-4666-8666-666666666666' },
        data: { expectedVersionId: head.versionId },
      },
    );
    expect(role.status()).toBe(401);
  } finally {
    await closeShows([controller]);
    await fixture.close();
  }
});
