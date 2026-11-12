(function (root, factory) {
  const prompterText = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = prompterText;
  } else {
    root.PrompterText = prompterText;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Returns 'direction' | 'lyric' | 'singalong' | 'dialogue'.
  // Marker order matches the stage: a brace wins, then ##, then <.
  function lineType(text) {
    if (/^\s*\{/.test(text)) return 'direction';
    if (/^\s*##/.test(text)) return 'lyric';
    if (/^\s*</.test(text)) return 'singalong';
    return 'dialogue';
  }

  // Strip display markers from raw text. Dialogue is returned unchanged.
  function displayText(text, type) {
    if (type === 'direction') return text.replace(/^\s*\{/, '').replace(/\}\s*$/, '').trim();
    // For lyrics: strip leading ## and trailing ## (the ## may appear at start or end of any line in the block)
    if (type === 'lyric') return text.replace(/^\s*##\s*/, '').replace(/\s*##.*$/, '').trim();
    if (type === 'singalong') return text.replace(/^\s*<\s*/, '').replace(/\s*>\s*$/, '').trim();
    return text;
  }

  return { lineType, displayText };
}));
