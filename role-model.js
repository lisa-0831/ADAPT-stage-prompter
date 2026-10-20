(function (root, factory) {
  const roleModel = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = roleModel;
  } else {
    root.RoleModel = roleModel;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ROLES = Object.freeze({
    CONTROLLER: 'controller',
    ACTOR: 'actor',
    AUDIENCE: 'audience',
  });
  const URL_ROLES = Object.freeze([
    ROLES.CONTROLLER,
    ROLES.ACTOR,
    ROLES.AUDIENCE,
    'viewer',
  ]);

  function isKnownUrlRole(value) {
    return URL_ROLES.includes(value);
  }

  function resolveRole(value) {
    if (value === ROLES.CONTROLLER || value === ROLES.ACTOR) {
      return value;
    }

    // "viewer" is the legacy name for the non-interactive audience view.
    return ROLES.AUDIENCE;
  }

  return { ROLES, isKnownUrlRole, resolveRole };
}));
