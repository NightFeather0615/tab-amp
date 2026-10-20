'use strict';

/*
 * Runs in every frame. Media elements are routed through a Web Audio GainNode so
 * the volume can go above 100%. Elements whose audio Web Audio can't read
 * (cross-origin media without CORS, or media the page already routes through
 * its own AudioContext) fall back to `element.volume`, which can only go down.
 */
(() => {
  // The manifest and the popup (for tabs opened before install) can both inject this file.
  if (globalThis.__tabAmp) return;

  const DEFAULT_VOLUME = 100;
  const SMOOTHING = 0.015; // seconds; avoids clicks when the gain changes
  const GESTURES = ['pointerdown', 'keydown', 'touchend'];

  let volume = DEFAULT_VOLUME;
  let ctx = null;
  let master = null; // one GainNode per frame; every routed element connects to it
  let waitingForGesture = false;

  // Media seen outside the DOM (e.g. `new Audio()`); in-DOM media is found with querySelectorAll.
  const detached = new Set();
  // element -> { mode: 'gain' } | { mode: 'volume', base, expected }
  const routes = new WeakMap();

  /* ---------- discovery ---------- */

  function collectMedia() {
    const media = new Set(document.querySelectorAll('video, audio'));
    for (const el of detached) {
      if (el.isConnected || el.paused) detached.delete(el);
      else media.add(el);
    }
    return media;
  }

  function notice(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    if (!el.isConnected) detached.add(el);
    if (volume !== DEFAULT_VOLUME) apply(el);
  }

  // Media events don't bubble, but they do pass through window during capture.
  for (const type of ['play', 'loadedmetadata']) {
    window.addEventListener(type, (event) => notice(event.target), true);
  }
  window.addEventListener('volumechange', onVolumeChange, true);

  // Events from media outside the DOM or inside shadow roots never reach window,
  // so also notice elements when the page calls play(). Firefox-only API.
  if (typeof exportFunction === 'function' && window.wrappedJSObject) {
    try {
      const proto = window.wrappedJSObject.HTMLMediaElement.prototype;
      const nativePlay = proto.play;
      exportFunction(
        function play(...args) {
          try {
            notice(this);
          } catch {
            // Never get in the way of playback.
          }
          return Reflect.apply(nativePlay, this, args);
        },
        proto,
        { defineAs: 'play' },
      );
    } catch {
      // Leave play() alone if the page's prototype isn't reachable.
    }
  }

  /* ---------- routing ---------- */

  /** 'ok' if Web Audio can read the element's audio, 'opaque' if it would be silenced, 'unknown' before it has a source. */
  function audioAccess(el) {
    if (el.srcObject) return 'ok';
    const src = el.currentSrc || el.src || el.querySelector('source[src]')?.src;
    if (!src) return 'unknown';
    let url;
    try {
      url = new URL(src, document.baseURI);
    } catch {
      return 'opaque';
    }
    if (url.protocol === 'blob:' || url.protocol === 'data:' || url.origin === location.origin) return 'ok';
    // Cross-origin audio is only readable when it was fetched with CORS.
    return el.crossOrigin ? 'ok' : 'opaque';
  }

  function getContext() {
    if (ctx) return ctx;
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
    master = ctx.createGain();
    master.gain.value = volume / 100;
    master.connect(ctx.destination);
    ctx.addEventListener('statechange', () => {
      if (ctx.state !== 'running' || !waitingForGesture) return;
      waitingForGesture = false;
      for (const type of GESTURES) window.removeEventListener(type, resumeContext, true);
      for (const el of collectMedia()) apply(el);
    });
    return ctx;
  }

  function resumeContext() {
    ctx?.resume().catch(() => {});
  }

  /**
   * Whether audio routed into the context will be heard. A context created
   * before the user interacted with the page stays suspended, and routing
   * media into it would silence that media.
   */
  function contextCanPlay(context) {
    if (context.state === 'running') return true;
    if (context.state === 'closed') return false;
    resumeContext();
    try {
      // A new context reports 'suspended' until its audio thread starts, even when it's allowed to play.
      if (navigator.getAutoplayPolicy?.(context) === 'allowed') return true;
    } catch {
      // Older Firefox without autoplay policy detection.
    }
    if (!waitingForGesture) {
      waitingForGesture = true;
      for (const type of GESTURES) window.addEventListener(type, resumeContext, { capture: true, passive: true });
    }
    return false;
  }

  function createRoute(el) {
    const access = audioAccess(el);
    if (access === 'unknown') return null; // Try again once it has a source (loadedmetadata/play).
    if (access === 'opaque') return { mode: 'volume' };
    const context = getContext();
    if (!context) return { mode: 'volume' };
    if (!contextCanPlay(context)) return null;
    try {
      context.createMediaElementSource(el).connect(master);
      return { mode: 'gain' };
    } catch {
      // The page already routes this element through its own AudioContext.
      return { mode: 'volume' };
    }
  }

  function apply(el) {
    try {
      applyRoute(el);
    } catch {
      // One odd element shouldn't stop the others from updating.
    }
  }

  function applyRoute(el) {
    let route = routes.get(el);
    if (!route) {
      if (volume === DEFAULT_VOLUME) return;
      route = createRoute(el);
      if (!route) return;
      routes.set(el, route);
    }
    // Routed elements follow the master gain; only fallback elements need individual updates.
    if (route.mode === 'volume') setElementVolume(el, route);
  }

  /* ---------- fallback: element.volume ---------- */

  function setElementVolume(el, route) {
    if (route.base === undefined) route.base = el.volume;
    route.expected = route.base * (Math.min(volume, DEFAULT_VOLUME) / 100);
    if (Math.abs(el.volume - route.expected) > 1e-6) el.volume = route.expected;
  }

  function onVolumeChange(event) {
    const el = event.target;
    const route = routes.get(el);
    if (route?.mode !== 'volume' || route.expected === undefined) return;
    if (Math.abs(el.volume - route.expected) < 1e-3) return; // our own change
    // The page changed its own volume; keep scaling relative to what it asked for.
    route.base = el.volume;
    setElementVolume(el, route);
  }

  /* ---------- volume ---------- */

  function setVolume(next) {
    volume = next;
    if (master) master.gain.setTargetAtTime(volume / 100, ctx.currentTime, SMOOTHING);
    for (const el of collectMedia()) apply(el);
  }

  /** Counts for the popup. `limited` and `waiting` only count media that is playing, so they need attention now. */
  function stats() {
    let total = 0;
    let playing = 0;
    let limited = 0;
    let waiting = 0;
    for (const el of collectMedia()) {
      total++;
      if (el.paused || el.ended) continue;
      playing++;
      const route = routes.get(el);
      if (route?.mode === 'volume') limited++;
      else if (!route && waitingForGesture && volume !== DEFAULT_VOLUME) waiting++;
    }
    return {
      volume,
      total,
      playing,
      limited,
      waiting,
      context: ctx?.state ?? 'none',
      gain: master?.gain.value ?? 1,
    };
  }

  globalThis.__tabAmp = { stats };

  /* ---------- messaging ---------- */

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === 'tabamp:apply' && Number.isFinite(message.volume)) setVolume(message.volume);
  });

  function sync() {
    browser.runtime.sendMessage({ type: 'content:hello' }).then(
      (reply) => {
        if (Number.isFinite(reply?.volume)) setVolume(reply.volume);
      },
      () => {},
    );
  }

  sync();
  // Pages restored from the back/forward cache may have missed updates.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) sync();
  });
})();
