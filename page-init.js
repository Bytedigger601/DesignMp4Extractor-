// Runs before any page script. Replaces real-time RAF with a controllable
// virtual clock so we can step the Claude Design Stage animation frame-by-frame.
(function () {
  let virtualTime = 0;
  let rafCallbacks = [];
  let rafIdCounter = 0;

  window.requestAnimationFrame = function (cb) {
    rafIdCounter++;
    rafCallbacks.push({ id: rafIdCounter, cb });
    return rafIdCounter;
  };
  window.cancelAnimationFrame = function (id) {
    rafCallbacks = rafCallbacks.filter((r) => r.id !== id);
  };

  const realPerfNow = performance.now.bind(performance);
  const startNow = realPerfNow();
  performance.now = function () {
    return startNow + virtualTime;
  };

  const fireRAFs = () => {
    const cbs = rafCallbacks;
    rafCallbacks = [];
    const ts = performance.now();
    for (const { cb } of cbs) {
      try { cb(ts); } catch (e) { console.error('[extractor] RAF cb err:', e); }
    }
  };

  window.__animExtractor = {
    advanceMs(ms) {
      virtualTime += ms;
      fireRAFs();
    },
    setTimeMs(ms) {
      virtualTime = ms;
      fireRAFs();
    },
    getTimeMs() { return virtualTime; },
    pendingRAFCount() { return rafCallbacks.length; },
  };

  // Capture Stage props by patching React.createElement once React loads.
  const tryPatch = () => {
    if (typeof React === 'undefined' || !React.createElement) return false;
    if (window.__reactPatchedForExtractor) return true;
    window.__reactPatchedForExtractor = true;
    const origCreate = React.createElement;
    React.createElement = function (type, props) {
      if (
        typeof type === 'function' &&
        type.name === 'Stage' &&
        props &&
        !window.__stageProps
      ) {
        window.__stageProps = {
          width: props.width,
          height: props.height,
          duration: props.duration,
          fps: props.fps || 60,
          background: props.background,
          persistKey: props.persistKey,
        };
      }
      return origCreate.apply(this, arguments);
    };
    return true;
  };

  if (!tryPatch()) {
    const iv = setInterval(() => { if (tryPatch()) clearInterval(iv); }, 5);
  }

  // Wipe persisted playhead so we always start at t=0.
  try { localStorage.clear(); } catch {}
})();
