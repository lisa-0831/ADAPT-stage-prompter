(function (root, factory) {
  const captionCase = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = captionCase;
  } else {
    root.CaptionCase = captionCase;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SENTENCE_START = /(^[\s]*|[.!?]+['"’”)\]]*\s+)(\p{L})/gu;
  const PRONOUN_I = /(^|\P{L})i(?=\P{L}|['’]|$)/gu;

  function toSentenceCase(text) {
    const lower = text.toLocaleLowerCase('en-US');
    const sentenced = lower.replace(
      SENTENCE_START,
      (_, lead, letter) => lead + letter.toLocaleUpperCase('en-US'),
    );
    return sentenced.replace(PRONOUN_I, (_, lead) => `${lead}I`);
  }

  return { toSentenceCase };
}));
