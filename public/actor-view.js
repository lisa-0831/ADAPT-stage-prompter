(function (root, factory) {
  const createActorView = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = { createActorView };
  } else {
    root.PrompterActor = createActorView();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const RETURN_TRANSITION_DURATION = 400;

  function createActorView(deps) {
    const liveShow = (deps && deps.liveShow) || PrompterLiveShow;
    const stage = (deps && deps.stage) || PrompterStage;
    const navigation = (deps && deps.navigation) || NavigationModel;
    const actorMode = (deps && deps.actorMode) || ActorModeModel;
    const matchMedia = (deps && deps.matchMedia) || ((query) => window.matchMedia(query));
    const doc = (deps && deps.document) || document;

    let readingState = actorMode.followLive();
    let returnTransition = null;
    let enabled = false;
    let getConnection = () => ({ status: 'connecting', waitingForLiveState: true });
    let stageElement = null;
    let els = null;

    function effectivePosition() {
      return actorMode.effectivePosition(readingState, liveShow.getLiveState());
    }

    function followsLive() {
      return readingState.mode === actorMode.MODES.FOLLOW_LIVE;
    }

    function isReturning() {
      return Boolean(returnTransition);
    }

    function positionForStateMessage() {
      if (followsLive() || returnTransition) {
        return {
          render: true,
          position: returnTransition ? liveShow.getLiveState() : null,
        };
      }
      return { render: false, position: null };
    }

    function bindControls(controls) {
      controls.btnActorPrev.onclick = () => navigate('prev');
      controls.btnActorNext.onclick = () => navigate('next');
      controls.btnReturnLive.onclick = () => returnToLive();
      controls.zonePrev.onclick = () => navigate('prev');
      controls.zoneNext.onclick = () => navigate('next');
    }

    function init(options) {
      const settings = options || {};
      enabled = true;
      if (settings.getConnection) getConnection = settings.getConnection;
      stageElement = settings.stageElement
        || (doc.getElementById && doc.getElementById('stage'));
      if (settings.elements) {
        els = settings.elements;
      } else {
        els = {
          actorModeStatus: doc.getElementById('actor-mode-status'),
          actorLivePosition: doc.getElementById('actor-live-position'),
          actorLiveRelative: doc.getElementById('actor-live-relative'),
          btnReturnLive: doc.getElementById('btn-return-live'),
          btnActorPrev: doc.getElementById('btn-actor-prev'),
          btnActorNext: doc.getElementById('btn-actor-next'),
          zonePrev: doc.getElementById('zone-prev'),
          zoneNext: doc.getElementById('zone-next'),
        };
      }
      if (settings.bindControls !== false && els.btnActorPrev) bindControls(els);
    }

    function livePositionLabel() {
      const slides = liveShow.getSlides();
      const liveState = liveShow.getLiveState();
      if (!liveState || !slides.length) return 'Live position unavailable';

      const position = navigation.normalizePosition(slides, liveState);
      const slide = slides[position.slideIndex];
      let cueLabel = 'No dialogue';

      if (position.showTitleImage && slide.titleImage) {
        cueLabel = 'Title image';
      } else if (slide.lines.length > 0) {
        cueLabel = `Line ${position.lineIndex + 1}/${slide.lines.length}`;
      }

      const connection = getConnection();
      const isFresh = connection.status === 'connected' && !connection.waitingForLiveState;
      const prefix = isFresh ? 'Live' : 'Last known live';
      return `${prefix}: Scene ${position.slideIndex + 1}/${slides.length} · ${cueLabel}`;
    }

    function updateLiveAwareness() {
      if (!els) return;
      els.actorLivePosition.textContent = livePositionLabel();
      els.actorLiveRelative.textContent = '';

      const slides = liveShow.getSlides();
      const liveState = liveShow.getLiveState();
      if (
        readingState.mode !== actorMode.MODES.BROWSING
        || !readingState.localPosition
        || !liveState
      ) {
        return;
      }

      const distance = navigation.cueDistance(
        slides,
        readingState.localPosition,
        liveState,
      );
      if (distance === null) return;

      if (distance === 0) {
        els.actorLiveRelative.textContent = 'At live position.';
      } else {
        const cueLabel = Math.abs(distance) === 1 ? 'cue' : 'cues';
        const relation = distance > 0 ? 'ahead' : 'behind';
        els.actorLiveRelative.textContent =
          `Live is ${Math.abs(distance)} ${cueLabel} ${relation}.`;
      }
    }

    function updateStatus() {
      if (!enabled || !els || !els.actorModeStatus) return;

      const isBrowsing = readingState.mode === actorMode.MODES.BROWSING;
      const connection = getConnection();
      const hasFreshLiveState = connection.status === 'connected'
        && !connection.waitingForLiveState
        && Boolean(liveShow.getLiveState());

      if (returnTransition) {
        els.actorModeStatus.textContent = 'RETURNING TO LIVE';
        els.actorModeStatus.dataset.mode = 'BROWSING';
      } else if (isBrowsing) {
        els.actorModeStatus.textContent = connection.status === 'connected'
          ? 'BROWSING'
          : 'BROWSING · RECONNECTING';
        els.actorModeStatus.dataset.mode = 'BROWSING';
      } else if (connection.status === 'connecting') {
        els.actorModeStatus.textContent = 'CONNECTING';
        els.actorModeStatus.dataset.mode = 'DISCONNECTED';
      } else if (!hasFreshLiveState) {
        els.actorModeStatus.textContent = connection.status === 'connected'
          ? 'WAITING FOR LIVE'
          : 'RECONNECTING';
        els.actorModeStatus.dataset.mode = 'DISCONNECTED';
      } else {
        els.actorModeStatus.textContent = 'FOLLOWING LIVE';
        els.actorModeStatus.dataset.mode = 'FOLLOW_LIVE';
      }

      els.btnReturnLive.disabled =
        Boolean(returnTransition) || !isBrowsing || !hasFreshLiveState;
      updateLiveAwareness();
    }

    function navigate(direction) {
      if (!enabled) return;
      const slides = liveShow.getSlides();
      if (!slides.length) return;

      cancelReturnTransition();
      const startingPosition = effectivePosition();
      if (!startingPosition) return;
      const nextPosition = navigation.movePosition(slides, startingPosition, direction);
      readingState = actorMode.browse(nextPosition);
      updateStatus();
      stage.render();
    }

    function cancelReturnTransition() {
      if (!returnTransition) return;

      clearTimeout(returnTransition.completionTimer);
      returnTransition.outgoingAnimation.cancel();
      returnTransition.incomingAnimation.cancel();
      returnTransition.snapshot.remove();
      returnTransition = null;
    }

    function finishReturnTransition() {
      cancelReturnTransition();
      readingState = actorMode.followLive();
      stage.render();
      updateStatus();
    }

    function createStageSnapshot() {
      const bounds = stageElement.getBoundingClientRect();
      const snapshot = stageElement.cloneNode(true);
      snapshot.id = 'return-transition-snapshot';
      Object.assign(snapshot.style, {
        position: 'fixed',
        top: `${bounds.top}px`,
        left: `${bounds.left}px`,
        width: `${bounds.width}px`,
        height: `${bounds.height}px`,
        margin: '0',
        zIndex: '50',
      });
      doc.body.appendChild(snapshot);
      return snapshot;
    }

    function startReturnTransition(direction) {
      if (!stageElement.animate) {
        finishReturnTransition();
        return;
      }

      const snapshot = createStageSnapshot();
      stage.render(liveShow.getLiveState());

      const offset = direction > 0 ? -48 : 48;
      const animationOptions = {
        duration: RETURN_TRANSITION_DURATION,
        easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
        fill: 'both',
      };
      const outgoingAnimation = snapshot.animate([
        { opacity: 1, transform: 'translateY(0)' },
        { opacity: 0, transform: `translateY(${offset}px)` },
      ], animationOptions);
      const incomingAnimation = stageElement.animate([
        { opacity: 0.65, transform: `translateY(${-offset}px)` },
        { opacity: 1, transform: 'translateY(0)' },
      ], animationOptions);

      const transition = {
        completionTimer: null,
        incomingAnimation,
        outgoingAnimation,
        snapshot,
      };
      returnTransition = transition;
      transition.completionTimer = setTimeout(() => {
        if (returnTransition === transition) finishReturnTransition();
      }, RETURN_TRANSITION_DURATION + 30);
      updateStatus();

      Promise.allSettled([
        outgoingAnimation.finished,
        incomingAnimation.finished,
      ]).then(() => {
        if (returnTransition === transition) finishReturnTransition();
      });
    }

    function returnToLive() {
      const slides = liveShow.getSlides();
      const liveState = liveShow.getLiveState();
      const connection = getConnection();
      const hasFreshLiveState = connection.status === 'connected'
        && !connection.waitingForLiveState
        && Boolean(liveState);
      if (!enabled || !hasFreshLiveState) return;

      const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const distance = navigation.cueDistance(
        slides,
        readingState.localPosition,
        liveState,
      );
      if (reducedMotion || distance === null || distance === 0) {
        finishReturnTransition();
        return;
      }

      cancelReturnTransition();
      startReturnTransition(distance);
    }

    function onScriptChanged() {
      cancelReturnTransition();
      readingState = actorMode.followLive();
    }

    function onSocketClosed() {
      const browsing = readingState.mode === actorMode.MODES.BROWSING;
      cancelReturnTransition();
      return browsing;
    }

    return {
      init,
      navigate,
      returnToLive,
      effectivePosition,
      updateStatus,
      onScriptChanged,
      onSocketClosed,
      followsLive,
      isReturning,
      positionForStateMessage,
    };
  }

  return createActorView;
}));
