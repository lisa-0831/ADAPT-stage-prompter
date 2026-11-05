(function (root, factory) {
  const subtitleLayout = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = subtitleLayout;
  } else {
    root.SubtitleLayout = subtitleLayout;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Scales with the caption instead of the old 16px root em.
  const DIRECTION_BLOCK_GAP = '0.85em';
  // A sliver of the active cue is not enough to read after a resize or zoom.
  const MIN_VISIBLE_CUE = 48;

  function cueRevealOffset(bounds) {
    const stageTop = bounds.stageTop;
    const stageBottom = bounds.stageBottom;
    const cueTop = bounds.cueTop;
    const cueBottom = bounds.cueBottom;
    const stageHeight = stageBottom - stageTop;
    const cueHeight = cueBottom - cueTop;
    if (stageHeight <= 0 || cueHeight <= 0) return 0;

    const visible = Math.max(
      0,
      Math.min(cueBottom, stageBottom) - Math.max(cueTop, stageTop),
    );
    if (visible >= Math.min(cueHeight, stageHeight) - 0.5) return 0;
    if (visible > MIN_VISIBLE_CUE && cueTop >= stageTop - 0.5) return 0;

    const delta = cueTop - stageTop;
    return delta > 0 ? delta : 0;
  }

  return { DIRECTION_BLOCK_GAP, MIN_VISIBLE_CUE, cueRevealOffset };
}));
