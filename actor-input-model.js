(function (root, factory) {
  const actorInputModel = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = actorInputModel;
  } else {
    root.ActorInputModel = actorInputModel;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const KEY_DIRECTIONS = Object.freeze({
    ArrowLeft: 'prev',
    ArrowUp: 'prev',
    ArrowRight: 'next',
    ArrowDown: 'next',
    ' ': 'next',
  });

  function directionForKey(key) {
    return KEY_DIRECTIONS[key] || null;
  }

  return { directionForKey };
}));
