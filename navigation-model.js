(function (root, factory) {
  const navigationModel = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = navigationModel;
  } else {
    root.NavigationModel = navigationModel;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function linesFor(slide) {
    return Array.isArray(slide && slide.lines) ? slide.lines : [];
  }

  function positionAtStart(slides, slideIndex, base = {}) {
    const slide = slides[slideIndex];
    return {
      ...base,
      slideIndex,
      lineIndex: 0,
      showTitleImage: Boolean(slide && slide.titleImage),
    };
  }

  function positionAtEnd(slides, slideIndex, base = {}) {
    const slide = slides[slideIndex];
    const lines = linesFor(slide);
    return {
      ...base,
      slideIndex,
      lineIndex: Math.max(0, lines.length - 1),
      showTitleImage: lines.length === 0 && Boolean(slide && slide.titleImage),
    };
  }

  function normalizePosition(slides, position = {}) {
    if (!Array.isArray(slides) || slides.length === 0) {
      return {
        ...position,
        slideIndex: 0,
        lineIndex: 0,
        showTitleImage: false,
      };
    }

    const slideIndex = clamp(
      Number.isInteger(position.slideIndex) ? position.slideIndex : 0,
      0,
      slides.length - 1,
    );
    const slide = slides[slideIndex];
    const lines = linesFor(slide);
    const lineIndex = clamp(
      Number.isInteger(position.lineIndex) ? position.lineIndex : 0,
      0,
      Math.max(0, lines.length - 1),
    );

    return {
      ...position,
      slideIndex,
      lineIndex,
      showTitleImage: Boolean(position.showTitleImage && slide.titleImage),
    };
  }

  function movePosition(slides, position, direction) {
    const current = normalizePosition(slides, position);
    if (!Array.isArray(slides) || slides.length === 0) return current;

    const slide = slides[current.slideIndex];
    const lines = linesFor(slide);

    if (direction === 'next') {
      if (current.showTitleImage) {
        if (lines.length > 0) {
          return { ...current, lineIndex: 0, showTitleImage: false };
        }
        if (current.slideIndex < slides.length - 1) {
          return positionAtStart(slides, current.slideIndex + 1, current);
        }
      } else if (current.lineIndex < lines.length - 1) {
        return { ...current, lineIndex: current.lineIndex + 1 };
      } else if (current.slideIndex < slides.length - 1) {
        return positionAtStart(slides, current.slideIndex + 1, current);
      }
    }

    if (direction === 'prev') {
      if (current.showTitleImage) {
        if (current.slideIndex > 0) {
          return positionAtEnd(slides, current.slideIndex - 1, current);
        }
      } else if (lines.length > 0 && current.lineIndex > 0) {
        return { ...current, lineIndex: current.lineIndex - 1 };
      } else if (slide.titleImage) {
        return { ...current, lineIndex: 0, showTitleImage: true };
      } else if (current.slideIndex > 0) {
        return positionAtEnd(slides, current.slideIndex - 1, current);
      }
    }

    return current;
  }

  function positionsEqual(left, right) {
    return Boolean(left && right)
      && left.slideIndex === right.slideIndex
      && left.lineIndex === right.lineIndex
      && Boolean(left.showTitleImage) === Boolean(right.showTitleImage);
  }

  return { movePosition, normalizePosition, positionsEqual };
}));
