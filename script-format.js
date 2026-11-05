(function (root, factory) {
  const scriptFormat = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = scriptFormat;
  } else {
    root.ScriptFormat = scriptFormat;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // Slides separated by "---" on its own line. Kept identical to the
  // historical server parser so publishing still renders the same way.
  function parseScript(text) {
    const blocks = String(text).split(/\n---\n/);
    return blocks.map((block) => {
      const rawLines = block.split('\n').map(l => l.trimEnd()).filter(l => l.trim() !== '');
      if (rawLines.length === 0) return null;
      const title = rawLines[0].startsWith('#') ? rawLines[0].replace(/^#+\s*/, '') : rawLines[0];
      const rest = rawLines[0].startsWith('#') ? rawLines.slice(1) : rawLines;

      const lines = [];
      let speaker = '';
      let inLyric = false;
      let inSingalong = false;
      let titleImage = null;

      for (const raw of rest) {
        if (raw.trim() === '') continue;

        if (/^\s*@image:\s*/.test(raw)) {
          titleImage = raw.replace(/^\s*@image:\s*/, '').trim();
          continue;
        }

        const nameMatch = raw.match(/^\s*\[([^\]]+)\](?:\s*&\s*\[([^\]]+)\])?\s*$/);
        if (nameMatch) {
          speaker = nameMatch[2] ? `${nameMatch[1]} & ${nameMatch[2]}` : nameMatch[1];
          continue;
        }

        const startsLyric = /^\s*##/.test(raw);
        const endsLyric = /##\s*$/.test(raw);
        const startsSingalong = /^\s*</.test(raw);
        const endsSingalong = />[\s]*$/.test(raw);

        if (startsLyric) inLyric = true;
        if (startsSingalong) inSingalong = true;

        let text;
        if (inLyric) {
          text = '## ' + raw.replace(/^\s*##\s*/, '').replace(/\s*##\s*$/, '').trim();
        } else if (inSingalong) {
          text = '<' + raw.replace(/^\s*<\s*/, '').replace(/\s*>\s*$/, '').trim();
        } else {
          text = raw;
        }

        lines.push({ text, speaker });
        speaker = '';
        if (endsLyric) inLyric = false;
        if (endsSingalong) inSingalong = false;
      }
      return { title, lines, titleImage };
    }).filter(Boolean);
  }

  // Publishing keeps the scene and line numbers when they still exist.
  // Those numbers can point at different words after the text changes.
  // showTitleImage is left as it was; the viewer shows an image only
  // when the current scene still has one.
  function positionAfterScriptReplace(state, slides) {
    const current = state && typeof state === 'object' ? state : {};
    const showTitleImage = !!current.showTitleImage;
    const showLine = current.showLine !== false;
    if (!Array.isArray(slides) || slides.length === 0) {
      return { slideIndex: 0, lineIndex: 0, showTitleImage, showLine };
    }
    const slideIndex = clamp(
      Number.isInteger(current.slideIndex) ? current.slideIndex : 0,
      0,
      slides.length - 1,
    );
    const lines = Array.isArray(slides[slideIndex] && slides[slideIndex].lines)
      ? slides[slideIndex].lines
      : [];
    const lineIndex = clamp(
      Number.isInteger(current.lineIndex) ? current.lineIndex : 0,
      0,
      Math.max(0, lines.length - 1),
    );
    return { slideIndex, lineIndex, showTitleImage, showLine };
  }

  return { parseScript, positionAfterScriptReplace };
}));
