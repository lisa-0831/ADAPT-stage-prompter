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
    const imageOnly = lines.length === 0 && Boolean(slide && slide.titleImage);

    return {
      ...position,
      slideIndex,
      lineIndex,
      showTitleImage: imageOnly || Boolean(position.showTitleImage && slide && slide.titleImage),
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

    if (direction === 'nextSlide' && current.slideIndex < slides.length - 1) {
      return positionAtStart(slides, current.slideIndex + 1, current);
    }

    if (direction === 'prevSlide' && current.slideIndex > 0) {
      return positionAtStart(slides, current.slideIndex - 1, current);
    }

    return current;
  }

  function positionsEqual(left, right) {
    return Boolean(left && right)
      && left.slideIndex === right.slideIndex
      && left.lineIndex === right.lineIndex
      && Boolean(left.showTitleImage) === Boolean(right.showTitleImage);
  }

  function cueCount(slide) {
    const lines = linesFor(slide);
    if (slide && slide.titleImage) return Math.max(1, lines.length + 1);
    return Math.max(1, lines.length);
  }

  function cueIndex(slides, position) {
    if (!Array.isArray(slides) || slides.length === 0 || !position) return null;

    const current = normalizePosition(slides, position);
    const priorCues = slides
      .slice(0, current.slideIndex)
      .reduce((total, slide) => total + cueCount(slide), 0);
    const slide = slides[current.slideIndex];
    const lines = linesFor(slide);

    if (slide.titleImage) {
      if (current.showTitleImage || lines.length === 0) return priorCues;
      return priorCues + current.lineIndex + 1;
    }

    return priorCues + (lines.length > 0 ? current.lineIndex : 0);
  }

  function cueProgressPercent(slides, position) {
    const index = cueIndex(slides, position);
    if (!Array.isArray(slides) || index === null) return 0;
    const total = slides.reduce((sum, slide) => sum + cueCount(slide), 0);
    if (total <= 1) return 0;
    return (index / (total - 1)) * 100;
  }

  function cueStatusLabel(slides, position) {
    if (!Array.isArray(slides) || slides.length === 0 || !position) return '';
    const current = normalizePosition(slides, position);
    const slide = slides[current.slideIndex] || { lines: [] };
    const lines = linesFor(slide);
    const scene = `Slide ${current.slideIndex + 1}/${slides.length}`;
    if (slide.titleImage && current.showTitleImage) return `${scene} · Title image`;
    return `${scene} · Line ${current.lineIndex + 1}/${lines.length}`;
  }

  function cueDistance(slides, actorPosition, livePosition) {
    const actorCue = cueIndex(slides, actorPosition);
    const liveCue = cueIndex(slides, livePosition);
    if (actorCue === null || liveCue === null) return null;
    return liveCue - actorCue;
  }

  return {
    cueDistance,
    cueIndex,
    cueProgressPercent,
    cueStatusLabel,
    movePosition,
    normalizePosition,
    positionsEqual,
  };
}));
