(function (root, factory) {
  const createConnection = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = { createConnection };
  } else {
    root.PrompterConnection = createConnection();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const RECONNECT_DELAY = 1500;

  function createConnection(deps) {
    const liveShow = (deps && deps.liveShow) || PrompterLiveShow;
    const stage = (deps && deps.stage) || PrompterStage;
    const actor = (deps && deps.actor) || PrompterActor;
    const Socket = (deps && deps.WebSocket) || WebSocket;
    const locationRef = (deps && deps.location) || location;
    const schedule = (deps && deps.setTimeout) || setTimeout;
    const cancelTimer = (deps && deps.clearTimeout) || clearTimeout;

    let socket = null;
    let reconnectTimer = null;
    let connectionStatus = 'connecting';
    let waitingForLiveState = true;
    let isActor = false;
    let connDot = null;
    let connecting = null;
    let onScriptApplied = function () {};
    let onAwaitingLive = function () {};

    function getStatus() {
      return {
        status: connectionStatus,
        waitingForLiveState,
      };
    }

    function init(options) {
      const settings = options || {};
      isActor = Boolean(settings.isActor);
      connDot = settings.connDot || null;
      connecting = settings.connecting || null;
      if (settings.onScriptApplied) onScriptApplied = settings.onScriptApplied;
      if (settings.onAwaitingLive) onAwaitingLive = settings.onAwaitingLive;
    }

    function connect() {
      const proto = locationRef.protocol === 'https:' ? 'wss' : 'ws';
      socket = new Socket(`${proto}://${locationRef.host}`);

      socket.onopen = function () {
        cancelTimer(reconnectTimer);
        connectionStatus = 'connected';
        connDot.classList.add('connected');
        connecting.style.display = 'none';
        actor.updateStatus();
      };

      socket.onclose = function () {
        const actorBrowsing = isActor && actor.onSocketClosed();
        if (actorBrowsing) stage.render();
        connectionStatus = 'reconnecting';
        waitingForLiveState = true;
        connDot.classList.remove('connected');
        connecting.style.display = isActor && liveShow.getSlides().length ? 'none' : 'flex';
        actor.updateStatus();
        reconnectTimer = schedule(connect, RECONNECT_DELAY);
      };

      socket.onmessage = function (evt) {
        applyServerMessage(JSON.parse(evt.data));
      };
    }

    // The socket calls this synchronously, in the order messages arrive.
    // script updates the shared show and, on a revision change, returns an
    // Actor to Follow Live. state updates the live cue and does not move a
    // browsing Actor. This does not clear the live cue except through the
    // existing actor revision path, and it does not send navigation.
    function applyServerMessage(msg) {
      if (msg.type === 'script') {
        const awaiting = msg.awaitingLive === true;
        if (typeof liveShow.setAwaitingLive === 'function') liveShow.setAwaitingLive(awaiting);
        onAwaitingLive(awaiting);
        const scriptChanged = liveShow.applyScript(msg).scriptChanged;
        if (isActor && scriptChanged) {
          actor.onScriptChanged();
          liveShow.applyState(null);
          waitingForLiveState = true;
        }
        stage.rebuildSlideSelect();
        if (!isActor || !scriptChanged) stage.render();
        actor.updateStatus();
        onScriptApplied();
      } else if (msg.type === 'state') {
        if (msg.awaitingLive === true || (typeof liveShow.isAwaitingLive === 'function' && liveShow.isAwaitingLive())) {
          liveShow.applyState(null);
          waitingForLiveState = true;
          actor.updateStatus();
          return;
        }
        liveShow.applyState(msg.state);
        waitingForLiveState = false;
        if (!isActor) {
          stage.render();
        } else {
          const update = actor.positionForStateMessage();
          if (update.render) stage.render(update.position);
        }
        actor.updateStatus();
      }
    }

    function send(msg) {
      if (socket && socket.readyState === Socket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    }

    return {
      init,
      connect,
      send,
      getStatus,
      applyServerMessage,
    };
  }

  return createConnection;
}));
