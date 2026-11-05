const test = require('node:test');
const assert = require('node:assert/strict');

const { ROLES, isKnownUrlRole, resolveRole } = require('./role-model');

test('resolves each supported role', () => {
  assert.equal(resolveRole('controller'), ROLES.CONTROLLER);
  assert.equal(resolveRole('actor'), ROLES.ACTOR);
  assert.equal(resolveRole('audience'), ROLES.AUDIENCE);
});

test('maps the legacy viewer role to audience', () => {
  assert.equal(resolveRole('viewer'), ROLES.AUDIENCE);
});

test('identifies valid URL roles and rejects invalid values', () => {
  for (const role of ['controller', 'actor', 'audience', 'viewer']) {
    assert.equal(isKnownUrlRole(role), true);
  }

  assert.equal(isKnownUrlRole('actro'), false);
  assert.equal(isKnownUrlRole(''), false);
  assert.equal(isKnownUrlRole(null), false);
});

test('defaults missing and invalid roles to audience', () => {
  assert.equal(resolveRole(null), ROLES.AUDIENCE);
  assert.equal(resolveRole(''), ROLES.AUDIENCE);
  assert.equal(resolveRole('invalid'), ROLES.AUDIENCE);
  assert.equal(resolveRole('Controller'), ROLES.AUDIENCE);
});
