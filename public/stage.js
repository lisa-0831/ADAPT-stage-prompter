(function (root, factory) {
  const createStage = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = { createStage };
  } else {
    root.PrompterStage = createStage();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createStage(deps) {
    const library = (deps && deps.library) || ScriptLibrary;

    let formatCue = null;
    let getPosition = null;
    let els = null;

    function imageUrl(reference) {
      const parsed = library.parseImageReference(reference);
      if (parsed.kind === 'legacy') return parsed.path;
      if (parsed.kind === 'library') return library.liveAssetUrl(parsed.scriptId, parsed.assetId);
      return '';
    }

    function init(options) {
      formatCue = options.formatCue;
      getPosition = options.getPosition;
      els = {
        stage: document.getElementById('stage'),
        slideTitle: document.getElementById('slide-title'),
        linesPast: document.getElementById('lines-past'),
        linesCurrent: document.getElementById('lines-current'),
        linesFuture: document.getElementById('lines-future'),
        progressFill: document.getElementById('progress-fill'),
        ctrlStatus: document.getElementById('ctrl-status'),
        slideSelect: document.getElementById('slide-select'),
        titleOverlay: document.getElementById('title-image-overlay'),
        titleImage: document.getElementById('title-image'),
        titleMissing: document.getElementById('title-image-missing'),
      };
      els.titleImage.addEventListener('error', () => {
        if (!els.titleImage.dataset.resolved) return;
        els.titleImage.hidden = true;
        els.titleMissing.hidden = false;
      });
    }

    function render(positionOverride = null) {
      const slides = PrompterLiveShow.getSlides();
      if (!slides.length) return;
      const position = positionOverride || getPosition();
      if (!position) return;
      const slide = slides[position.slideIndex] || { title: '', lines: [] };
      const li = position.lineIndex;
      const lines = slide.lines;

      els.slideTitle.textContent = slide.title;
      const showingTitleImage = Boolean(position.showTitleImage && slide.titleImage);

      if (showingTitleImage) {
        const src = imageUrl(slide.titleImage);
        els.titleOverlay.classList.add('show');
        els.stage.scrollTop = 0;
        if (!src) {
          els.titleImage.hidden = true;
          els.titleImage.dataset.resolved = '';
          els.titleImage.removeAttribute('src');
          els.titleMissing.hidden = false;
        } else if (els.titleImage.dataset.resolved !== src || els.titleImage.hidden) {
          els.titleMissing.hidden = true;
          els.titleImage.hidden = false;
          els.titleImage.dataset.resolved = src;
          els.titleImage.src = src;
        }
      } else {
        els.titleOverlay.classList.remove('show');
        els.titleImage.dataset.resolved = '';
        els.titleImage.removeAttribute('src');
        els.titleImage.hidden = false;
        els.titleMissing.hidden = true;

        const from = Math.max(0, li - 3);
        const to = Math.min(lines.length - 1, li + 3);

        els.linesPast.innerHTML = '';
        els.linesCurrent.innerHTML = '';
        els.linesFuture.innerHTML = '';

        for (let i = from; i <= to; i++) {
          const { text: cueText, speaker } = lines[i];
          const type = PrompterText.lineType(cueText);
          const ahead = i - li;
          const linePosition = ahead < 0 ? 'past' : ahead === 0 ? 'current' : 'future';

          const prevSpeaker = i > from ? (lines[i - 1].speaker || '') : '';
          const showName = speaker && speaker !== prevSpeaker;

          const row = document.createElement('div');
          row.className = `line-row ${linePosition}`;
          if (type === 'direction') {
            if (i > from) row.style.marginTop = SubtitleLayout.DIRECTION_BLOCK_GAP;
            row.style.marginBottom = SubtitleLayout.DIRECTION_BLOCK_GAP;
          }

          const nameEl = document.createElement('div');
          nameEl.className = showName ? 'char-name' : 'char-name empty';
          nameEl.textContent = showName ? speaker : '';

          const textEl = document.createElement('div');
          textEl.className = `script-line ${type}`;
          textEl.textContent = formatCue(cueText, type);

          row.appendChild(nameEl);
          row.appendChild(textEl);

          if (i < li) els.linesPast.appendChild(row);
          else if (i === li) els.linesCurrent.appendChild(row);
          else els.linesFuture.appendChild(row);
        }
      }

      syncLiveCueChrome(position);
      if (!showingTitleImage) revealCurrentCue();
    }

    function syncLiveCueChrome(position) {
      const slides = PrompterLiveShow.getSlides();
      els.progressFill.style.width = `${NavigationModel.cueProgressPercent(slides, position)}%`;
      if (els.slideSelect.value !== String(position.slideIndex)) {
        els.slideSelect.value = String(position.slideIndex);
      }
      els.ctrlStatus.textContent = NavigationModel.cueStatusLabel(slides, position);
    }

    function revealCurrentCue() {
      const stage = els.stage;
      const current = els.linesCurrent;
      stage.scrollTop = 0;
      if (!current || current.childElementCount === 0) return;

      const stageRect = stage.getBoundingClientRect();
      const currentRect = current.getBoundingClientRect();
      const offset = SubtitleLayout.cueRevealOffset({
        stageTop: stageRect.top,
        stageBottom: stageRect.bottom,
        cueTop: currentRect.top,
        cueBottom: currentRect.bottom,
      });
      if (offset > 0) stage.scrollTop = offset;
    }

    function rebuildSlideSelect() {
      const slides = PrompterLiveShow.getSlides();
      els.slideSelect.innerHTML = '';
      slides.forEach((slide, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = `${index + 1}. ${slide.title}`;
        els.slideSelect.appendChild(option);
      });
      render();
    }

    return { init, render, rebuildSlideSelect, imageUrl };
  }

  return createStage;
}));
