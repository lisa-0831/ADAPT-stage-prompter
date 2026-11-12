(function (root, factory) {
  const createControllerView = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = { createControllerView };
  } else {
    root.PrompterController = createControllerView();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CASE_STORAGE_KEY = 'prompter-caption-case';

  function createControllerView(deps) {
    const textApi = (deps && deps.text) || PrompterText;
    const toSentenceCase = (deps && deps.toSentenceCase) || CaptionCase.toSentenceCase;
    const stage = (deps && deps.stage) || PrompterStage;
    const connection = (deps && deps.connection) || PrompterConnection;
    const defaultDocument = (deps && deps.document)
      || (typeof document !== 'undefined' ? document : null);

    let sentenceCase = false;
    let enabled = false;
    let storage = null;
    let canNavigate = null;
    let els = null;
    let swipeBound = false;
    let touchStartX = 0;
    let touchStartY = 0;

    function isEnabled() {
      return enabled;
    }

    function navigationAllowed() {
      return !canNavigate || canNavigate();
    }

    function readSentenceCase() {
      if (!storage) return false;
      try {
        return storage.getItem(CASE_STORAGE_KEY) === 'sentence';
      } catch (_) {
        return false;
      }
    }

    function writeSentenceCase() {
      if (!storage) return;
      try {
        storage.setItem(CASE_STORAGE_KEY, sentenceCase ? 'sentence' : 'caps');
      } catch (_) {
        // The toggle still applies for this page load.
      }
    }

    function updateCaseButton() {
      if (!els || !els.btnCase) return;
      els.btnCase.setAttribute('aria-pressed', sentenceCase ? 'true' : 'false');
      els.btnCase.textContent = sentenceCase ? 'Aa' : 'AA';
      els.btnCase.title = sentenceCase ? 'Switch to all caps' : 'Switch to sentence case';
    }

    function formatCue(text, type) {
      const plain = textApi.displayText(text, type);
      if (!sentenceCase) return plain;
      return toSentenceCase(plain);
    }

    function navigate(direction) {
      if (!enabled) return;
      connection.send({ type: 'navigate', direction });
    }

    function selectScene(slideIndex) {
      if (!enabled) return;
      connection.send({
        type: 'goto',
        slideIndex: parseInt(slideIndex),
        lineIndex: 0,
      });
    }

    function directionForKey(key) {
      if (key === 'ArrowRight' || key === 'ArrowDown' || key === ' ') return 'next';
      if (key === 'ArrowLeft' || key === 'ArrowUp') return 'prev';
      if (key === 'PageDown') return 'nextSlide';
      if (key === 'PageUp') return 'prevSlide';
      return null;
    }

    // Returns true when this key is a Controller shortcut that was sent.
    // The page owns focus checks and Actor keys, and supplies canNavigate
    // so an open editor or library blocks shortcuts without living here.
    function handleKey(key) {
      if (!enabled || !navigationAllowed()) return false;
      const direction = directionForKey(key);
      if (!direction) return false;
      navigate(direction);
      return true;
    }

    function toggleCase() {
      if (!enabled) return;
      sentenceCase = !sentenceCase;
      writeSentenceCase();
      updateCaseButton();
      stage.render();
    }

    function bindControls(controls) {
      if (controls.btnPrev) controls.btnPrev.onclick = () => navigate('prev');
      if (controls.btnNext) controls.btnNext.onclick = () => navigate('next');
      if (controls.btnPrevSlide) controls.btnPrevSlide.onclick = () => navigate('prevSlide');
      if (controls.btnNextSlide) controls.btnNextSlide.onclick = () => navigate('nextSlide');
      if (controls.zonePrev) controls.zonePrev.onclick = () => navigate('prev');
      if (controls.zoneNext) controls.zoneNext.onclick = () => navigate('next');
      if (controls.btnCase) controls.btnCase.onclick = () => toggleCase();
      if (controls.slideSelect) {
        controls.slideSelect.onchange = () => selectScene(controls.slideSelect.value);
      }
    }

    function bindSwipe(doc) {
      if (!doc || swipeBound) return;
      swipeBound = true;
      doc.addEventListener('touchstart', (event) => {
        touchStartX = event.touches[0].clientX;
        touchStartY = event.touches[0].clientY;
      }, { passive: true });
      doc.addEventListener('touchend', (event) => {
        if (!enabled || !navigationAllowed()) return;
        const dx = event.changedTouches[0].clientX - touchStartX;
        const dy = event.changedTouches[0].clientY - touchStartY;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
          navigate(dx < 0 ? 'next' : 'prev');
        }
      }, { passive: true });
    }

    function init(options) {
      const settings = options || {};
      enabled = true;
      storage = settings.storage || null;
      canNavigate = settings.canNavigate || null;
      sentenceCase = readSentenceCase();
      els = settings.elements || null;
      if (els) bindControls(els);
      updateCaseButton();
      bindSwipe(settings.document || defaultDocument);
    }

    return {
      init,
      formatCue,
      navigate,
      selectScene,
      handleKey,
      toggleCase,
      isEnabled,
    };
  }

  return createControllerView;
}));
