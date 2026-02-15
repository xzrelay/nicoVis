(() => {
  // ===== 設定値 =====
  const DEFAULT_PERCENT = 65;
  const DEFAULT_ENABLED = true;
  const DEFAULT_AUTO_BY_COMMENT = true;
  const DEFAULT_COMMENT_THRESHOLD = 10000;

  const TARGET_CLASS = "nico-vis-mask";
  const HIDE_PERCENT_VAR = "--nico-vis-hide-percent";

  const GUIDE_LINE_CLASS = "nico-vis-guide-line";
  const GUIDE_SHADE_CLASS = "nico-vis-guide-shade";
  const GUIDE_VISIBLE_MS = 650;
  const GUIDE_FADE_MS = 350;

  const MAX_MUTATION_NODES_PER_TICK = 80;
  const MAX_APPLY_BATCH_PER_FRAME = 50;

  const VIDEO_COMMENT_SELECTOR =
    "[data-styling-name='fullscreen-target'] [data-name='stage'] [data-name='comment']";
  const LIVE_COMMENT_SELECTOR = "[data-layer-name='commentLayer']";
  const COMMENT_PANEL_SELECTOR = "[data-name='comment'][role='tabpanel']";
  const GUIDE_VIDEO_SELECTORS = [
    "video[data-name='video-content']",
    "[data-layer-name='videoLayer'] video",
    "video",
  ];

  const MASK_GRADIENT = `linear-gradient(to bottom, #000 calc(100% - var(${HIDE_PERCENT_VAR})), transparent calc(100% - var(${HIDE_PERCENT_VAR})))`;

  // ===== 共有状態 =====
  const state = {
    enabled: DEFAULT_ENABLED,
    percent: DEFAULT_PERCENT,
    initialized: false,
    primaryTarget: null,
    guideVisibleUntil: 0,
    hideToken: 0,
    knownRoots: new Set([document]),
    observedRoots: new WeakSet(),
    pendingRoots: new Set(),
    autoByCommentCount: DEFAULT_AUTO_BY_COMMENT,
    commentThreshold: DEFAULT_COMMENT_THRESHOLD,
  };

  const refs = {
    mutationObserver: null,
    applyRafId: null,
    guideRafId: null,
    hideTimer: null,
    lineEl: null,
    shadeEl: null,
    messageListener: null,
    storageListener: null,
    resizeListener: null,
    scrollListener: null,
  };

  // ===== ユーティリティ =====
  function clampPercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return DEFAULT_PERCENT;
    return Math.min(100, Math.max(0, Math.round(num)));
  }

  function ensureRootPercentVar() {
    if (!document.documentElement.style.getPropertyValue(HIDE_PERCENT_VAR)) {
      document.documentElement.style.setProperty(HIDE_PERCENT_VAR, `${DEFAULT_PERCENT}%`);
    }
  }

  function safeQueryAll(root, selector) {
    if (!root || typeof root.querySelectorAll !== "function") return [];
    try {
      return root.querySelectorAll(selector);
    } catch {
      return [];
    }
  }

  function isLivePage() {
    return location.hostname === "live.nicovideo.jp";
  }

  function isWatchPage() {
    return location.hostname === "www.nicovideo.jp" && location.pathname.startsWith("/watch/");
  }

  function getTargetSelector() {
    return isLivePage() ? LIVE_COMMENT_SELECTOR : VIDEO_COMMENT_SELECTOR;
  }

  function getSchemaCommentCount() {
    const scripts = document.querySelectorAll("script[type='application/ld+json']");
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i];
      const raw = script.textContent;
      if (!raw) continue;

      try {
        const data = JSON.parse(raw);
        const count = findCommentCountInSchema(data);
        if (count !== null) return count;
      } catch (_) {
        continue;
      }
    }
    return null;
  }

  function findCommentCountInSchema(data) {
    if (!data) return null;

    if (Array.isArray(data)) {
      for (let i = 0; i < data.length; i++) {
        const count = findCommentCountInSchema(data[i]);
        if (count !== null) return count;
      }
      return null;
    }

    if (typeof data !== "object") return null;

    if (typeof data.commentCount !== "undefined") {
      const count = Number(data.commentCount);
      if (Number.isFinite(count) && count >= 0) return count;
    }

    if (Array.isArray(data["@graph"])) {
      const count = findCommentCountInSchema(data["@graph"]);
      if (count !== null) return count;
    }

    return null;
  }

  // Determine initial enabled state based on auto mode and comment count.
  // Only called once at initialization.
  function resolveInitialEnabled(storageEnabled) {
    if (!state.autoByCommentCount || !isWatchPage()) {
      return storageEnabled;
    }

    const commentCount = getSchemaCommentCount();
    if (!Number.isFinite(commentCount)) {
      // Comment count unavailable on a watch page with auto mode ON.
      // Default to enabled (safe fallback); storageEnabled is stale
      // from a different page's auto-determination.
      return DEFAULT_ENABLED;
    }

    return commentCount >= state.commentThreshold;
  }

  function isValidCommentLayer(el) {
    if (!(el instanceof Element)) return false;
    if (!el.isConnected) return false;
    if (el.matches(COMMENT_PANEL_SELECTOR)) return false;
    if (!el.querySelector("canvas")) return false;
    return true;
  }

  function isUsableGuideTarget(el) {
    if (!(el instanceof Element)) return false;
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findVideoGuideTargetInRoot(root) {
    if (root instanceof HTMLVideoElement && isUsableGuideTarget(root)) {
      return root;
    }

    for (let i = 0; i < GUIDE_VIDEO_SELECTORS.length; i++) {
      const selector = GUIDE_VIDEO_SELECTORS[i];
      const matches = safeQueryAll(root, selector);
      for (let j = 0; j < matches.length; j++) {
        const el = matches[j];
        if (isUsableGuideTarget(el)) {
          return el;
        }
      }
    }

    return null;
  }

  // ===== マスク適用 =====
  function clearMaskFromElement(el) {
    if (!(el instanceof Element)) return;

    el.classList.remove(TARGET_CLASS);
    el.style.removeProperty("-webkit-mask-image");
    el.style.removeProperty("mask-image");
    el.style.removeProperty("-webkit-mask-size");
    el.style.removeProperty("mask-size");
    el.style.removeProperty("-webkit-mask-repeat");
    el.style.removeProperty("mask-repeat");
  }

  function applyMaskToElement(el) {
    if (!(el instanceof Element)) return;

    if (!state.enabled) {
      clearMaskFromElement(el);
      return;
    }

    if (el.classList.contains(TARGET_CLASS)) return;

    el.classList.add(TARGET_CLASS);
    el.style.setProperty("-webkit-mask-image", MASK_GRADIENT);
    el.style.setProperty("mask-image", MASK_GRADIENT);
    el.style.setProperty("-webkit-mask-size", "100% 100%");
    el.style.setProperty("mask-size", "100% 100%");
    el.style.setProperty("-webkit-mask-repeat", "no-repeat");
    el.style.setProperty("mask-repeat", "no-repeat");
  }

  function collectTargetsInRoot(root) {
    const targets = new Set();
    const targetSelector = getTargetSelector();

    if (root instanceof Element && root.matches(targetSelector) && isValidCommentLayer(root)) {
      targets.add(root);
    }

    const matches = safeQueryAll(root, targetSelector);
    for (let i = 0; i < matches.length; i++) {
      const el = matches[i];
      if (isValidCommentLayer(el)) {
        targets.add(el);
      }
    }

    return targets;
  }

  function findFirstCommentGuideTarget(candidates) {
    for (const el of candidates) {
      if (!isValidCommentLayer(el) || !isUsableGuideTarget(el)) continue;
      return el;
    }
    return null;
  }

  function resolvePrimaryTarget(root, candidates) {
    const videoTarget = findVideoGuideTargetInRoot(root);
    if (videoTarget) return videoTarget;
    return findFirstCommentGuideTarget(candidates);
  }

  function applyMasksInRoot(root) {
    const targets = collectTargetsInRoot(root);
    for (const el of targets) {
      applyMaskToElement(el);
    }
    const nextTarget = resolvePrimaryTarget(root, targets);
    if (nextTarget) {
      state.primaryTarget = nextTarget;
    }
  }

  function enqueueApply(root) {
    state.pendingRoots.add(root || document);
    if (refs.applyRafId !== null) return;

    refs.applyRafId = requestAnimationFrame(() => {
      refs.applyRafId = null;
      flushApplyQueue();
    });
  }

  function flushApplyQueue() {
    if (state.pendingRoots.size === 0) return;

    const roots = Array.from(state.pendingRoots);
    state.pendingRoots.clear();

    const limit = Math.min(roots.length, MAX_APPLY_BATCH_PER_FRAME);
    for (let i = 0; i < limit; i++) {
      try {
        applyMasksInRoot(roots[i]);
      } catch (e) {
        console.error("[nicoVis] applyMasksInRoot failed:", e);
      }
    }

    if (roots.length > limit) {
      for (let i = limit; i < roots.length; i++) {
        state.pendingRoots.add(roots[i]);
      }
      enqueueApply(document);
    }
  }

  // ===== DOM監視 =====
  function observeRoot(root) {
    if (!root || !refs.mutationObserver || state.observedRoots.has(root)) return;

    try {
      refs.mutationObserver.observe(root, { childList: true, subtree: true });
      state.observedRoots.add(root);
      state.knownRoots.add(root);
    } catch (e) {
      console.error("[nicoVis] observeRoot failed:", e);
    }
  }

  function discoverShadowRoots() {
    const html = document.documentElement;
    if (!html) return;

    try {
      const walker = document.createTreeWalker(html, NodeFilter.SHOW_ELEMENT);
      let node = html;
      while (node) {
        if (node.shadowRoot) {
          observeRoot(node.shadowRoot);
          enqueueApply(node.shadowRoot);
        }
        node = walker.nextNode();
      }
    } catch (e) {
      console.error("[nicoVis] discoverShadowRoots failed:", e);
    }
  }

  function hasRelevantTarget(node) {
    if (!(node instanceof Element)) return false;
    const targetSelector = getTargetSelector();
    if (node.matches(targetSelector) && isValidCommentLayer(node)) return true;
    const matches = safeQueryAll(node, targetSelector);
    for (let i = 0; i < matches.length; i++) {
      if (isValidCommentLayer(matches[i])) return true;
    }
    return false;
  }

  function setupMutationObserver() {
    refs.mutationObserver = new MutationObserver((mutations) => {
      let processedNodes = 0;

      for (const mutation of mutations) {
        if (mutation.type !== "childList") continue;

        for (let i = 0; i < mutation.addedNodes.length; i++) {
          if (processedNodes >= MAX_MUTATION_NODES_PER_TICK) return;

          const node = mutation.addedNodes[i];
          if (!(node instanceof Element)) continue;
          processedNodes += 1;

          if (node.shadowRoot) {
            observeRoot(node.shadowRoot);
            enqueueApply(node.shadowRoot);
          }

          if (hasRelevantTarget(node)) {
            enqueueApply(node);
          }
        }
      }
    });

    observeRoot(document);
    discoverShadowRoots();
  }

  function refreshPrimaryTargetFromAllRoots() {
    for (const root of state.knownRoots) {
      const videoTarget = findVideoGuideTargetInRoot(root);
      if (videoTarget) {
        state.primaryTarget = videoTarget;
        return;
      }
    }

    const candidates = new Set();
    const targetSelector = getTargetSelector();

    for (const root of state.knownRoots) {
      const matches = safeQueryAll(root, targetSelector);
      for (let i = 0; i < matches.length; i++) {
        const el = matches[i];
        if (isValidCommentLayer(el)) {
          candidates.add(el);
        }
      }
    }

    const fallbackTarget = findFirstCommentGuideTarget(candidates);
    if (fallbackTarget) {
      state.primaryTarget = fallbackTarget;
    }
  }

  // ===== ガイドUI =====
  function ensureGuideElements() {
    if (!refs.lineEl) {
      refs.lineEl = document.createElement("div");
      refs.lineEl.className = GUIDE_LINE_CLASS;
      Object.assign(refs.lineEl.style, {
        position: "fixed",
        height: "2px",
        background: "rgba(90, 180, 255, 0.95)",
        boxShadow: "0 0 0 1px rgba(20, 30, 60, 0.25), 0 0 12px rgba(90, 180, 255, 0.65)",
        pointerEvents: "none",
        zIndex: "2147483647",
        opacity: "0",
        transition: `top 90ms linear, width 90ms linear, opacity ${GUIDE_FADE_MS}ms ease`,
        display: "none",
        left: "0",
        top: "0",
        right: "0",
      });
      document.body.appendChild(refs.lineEl);
    }

    if (!refs.shadeEl) {
      refs.shadeEl = document.createElement("div");
      refs.shadeEl.className = GUIDE_SHADE_CLASS;
      Object.assign(refs.shadeEl.style, {
        position: "fixed",
        background: "linear-gradient(to bottom, rgba(90, 180, 255, 0.12), rgba(20, 30, 60, 0.24))",
        pointerEvents: "none",
        zIndex: "2147483646",
        opacity: "0",
        transition: `top 90ms linear, height 90ms linear, width 90ms linear, opacity ${GUIDE_FADE_MS}ms ease`,
        display: "none",
        left: "0",
        top: "0",
        right: "0",
      });
      document.body.appendChild(refs.shadeEl);
    }
  }

  function hideGuide(delayMs = 0, immediate = false) {
    clearTimeout(refs.hideTimer);
    const token = ++state.hideToken;

    const completeHide = () => {
      if (token !== state.hideToken) return;
      if (refs.lineEl) refs.lineEl.style.display = "none";
      if (refs.shadeEl) refs.shadeEl.style.display = "none";
    };

    const startFadeOut = () => {
      if (refs.lineEl) refs.lineEl.style.opacity = "0";
      if (refs.shadeEl) refs.shadeEl.style.opacity = "0";
      refs.hideTimer = setTimeout(completeHide, GUIDE_FADE_MS);
    };

    if (immediate) {
      if (refs.lineEl) refs.lineEl.style.opacity = "0";
      if (refs.shadeEl) refs.shadeEl.style.opacity = "0";
      completeHide();
      return;
    }

    if (delayMs > 0) {
      refs.hideTimer = setTimeout(startFadeOut, delayMs);
      return;
    }

    startFadeOut();
  }

  function updateGuide() {
    refs.guideRafId = null;

    if (!state.enabled) {
      hideGuide(0, true);
      return;
    }

    ensureGuideElements();

    if (!state.primaryTarget || !state.primaryTarget.isConnected) {
      refreshPrimaryTargetFromAllRoots();
    }

    if (!state.primaryTarget || !state.primaryTarget.isConnected) {
      hideGuide(0, true);
      return;
    }

    const rect = state.primaryTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      hideGuide(0, true);
      return;
    }

    if (Date.now() > state.guideVisibleUntil) {
      hideGuide();
      return;
    }

    const hiddenRatio = state.percent / 100;
    const boundaryTop = rect.top + rect.height * (1 - hiddenRatio);
    const shadeHeight = Math.max(0, rect.bottom - boundaryTop);

    refs.lineEl.style.display = "block";
    refs.lineEl.style.left = `${rect.left}px`;
    refs.lineEl.style.top = `${boundaryTop}px`;
    refs.lineEl.style.width = `${rect.width}px`;

    refs.shadeEl.style.display = "block";
    refs.shadeEl.style.left = `${rect.left}px`;
    refs.shadeEl.style.top = `${boundaryTop}px`;
    refs.shadeEl.style.width = `${rect.width}px`;
    refs.shadeEl.style.height = `${shadeHeight}px`;

    refs.lineEl.style.opacity = "1";
    refs.shadeEl.style.opacity = shadeHeight > 0 ? "1" : "0";

    hideGuide(Math.max(0, state.guideVisibleUntil - Date.now()));
  }

  function requestGuideUpdate() {
    if (refs.guideRafId !== null) return;
    refs.guideRafId = requestAnimationFrame(updateGuide);
  }

  function pulseGuide() {
    state.guideVisibleUntil = Date.now() + GUIDE_VISIBLE_MS;
    requestGuideUpdate();
  }

  // ===== 状態同期 =====
  function updatePercent(value, showGuide) {
    const next = clampPercent(value);
    if (next === state.percent) return;

    state.percent = next;
    document.documentElement.style.setProperty(HIDE_PERCENT_VAR, `${next}%`);

    if (showGuide) {
      pulseGuide();
    }
  }

  function updateEnabled(value, showGuide) {
    const next = Boolean(value);
    if (next === state.enabled) return;

    state.enabled = next;

    if (!state.enabled) {
      hideGuide(0, true);
    } else if (showGuide) {
      pulseGuide();
    }

    for (const root of state.knownRoots) {
      enqueueApply(root);
    }
  }

  function bindRuntimeMessage() {
    refs.messageListener = (msg, _sender, sendResponse) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ping") {
        sendResponse({ active: true });
      }
    };

    chrome.runtime.onMessage.addListener(refs.messageListener);
  }

  function bindStorageSync() {
    chrome.storage.sync.get(
      {
        hidePercent: DEFAULT_PERCENT,
        enabled: DEFAULT_ENABLED,
        autoByCommentCount: DEFAULT_AUTO_BY_COMMENT,
        commentThreshold: DEFAULT_COMMENT_THRESHOLD,
      },
      (items) => {
        try {
          state.autoByCommentCount = Boolean(items.autoByCommentCount);
          state.commentThreshold = Math.max(0, Math.round(Number(items.commentThreshold) || 0));
          updatePercent(items.hidePercent, false);

          const storageEnabled = Boolean(items.enabled);
          const effectiveEnabled = resolveInitialEnabled(storageEnabled);

          // Set state directly instead of updateEnabled() to bypass its
          // same-value early return (state.enabled defaults to DEFAULT_ENABLED
          // which may equal effectiveEnabled, causing a no-op).
          state.enabled = effectiveEnabled;
          applyAllKnownRoots();

          // Sync auto-determined result back to storage for popup
          if (effectiveEnabled !== storageEnabled) {
            chrome.storage.sync.set({ enabled: effectiveEnabled });
          }
        } catch (e) {
          console.error("[nicoVis] storage init failed:", e);
        }
        state.initialized = true;
      }
    );

    refs.storageListener = (changes, area) => {
      if (area !== "sync") return;

      try {
        if (changes.hidePercent) {
          updatePercent(changes.hidePercent.newValue, state.initialized);
        }
        if (changes.enabled !== undefined) {
          updateEnabled(Boolean(changes.enabled.newValue), state.initialized);
        }
      } catch (e) {
        console.error("[nicoVis] storage change failed:", e);
      }
    };

    chrome.storage.onChanged.addListener(refs.storageListener);
  }

  function bindViewportEvents() {
    refs.resizeListener = () => {
      if (Date.now() <= state.guideVisibleUntil) {
        requestGuideUpdate();
      }
    };

    refs.scrollListener = () => {
      if (Date.now() <= state.guideVisibleUntil) {
        requestGuideUpdate();
      }
    };

    window.addEventListener("resize", refs.resizeListener);
    window.addEventListener("scroll", refs.scrollListener, { passive: true });
  }

  // ===== ライフサイクル =====
  function applyAllKnownRoots() {
    for (const root of state.knownRoots) {
      enqueueApply(root);
    }
  }

  function start() {
    ensureRootPercentVar();
    bindRuntimeMessage();
    bindStorageSync();
    setupMutationObserver();
    bindViewportEvents();
    applyAllKnownRoots();
  }

  function cleanup() {
    clearTimeout(refs.hideTimer);

    if (refs.guideRafId !== null) {
      cancelAnimationFrame(refs.guideRafId);
      refs.guideRafId = null;
    }

    if (refs.applyRafId !== null) {
      cancelAnimationFrame(refs.applyRafId);
      refs.applyRafId = null;
    }

    if (refs.mutationObserver) {
      refs.mutationObserver.disconnect();
      refs.mutationObserver = null;
    }

    if (refs.resizeListener) {
      window.removeEventListener("resize", refs.resizeListener);
      refs.resizeListener = null;
    }

    if (refs.scrollListener) {
      window.removeEventListener("scroll", refs.scrollListener);
      refs.scrollListener = null;
    }

    if (refs.messageListener && chrome.runtime.onMessage.hasListener(refs.messageListener)) {
      chrome.runtime.onMessage.removeListener(refs.messageListener);
      refs.messageListener = null;
    }

    if (refs.storageListener && chrome.storage.onChanged.hasListener(refs.storageListener)) {
      chrome.storage.onChanged.removeListener(refs.storageListener);
      refs.storageListener = null;
    }

    state.pendingRoots.clear();
    state.knownRoots.clear();
    state.primaryTarget = null;

    if (refs.lineEl && refs.lineEl.parentNode) refs.lineEl.parentNode.removeChild(refs.lineEl);
    if (refs.shadeEl && refs.shadeEl.parentNode) refs.shadeEl.parentNode.removeChild(refs.shadeEl);
    refs.lineEl = null;
    refs.shadeEl = null;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }

  window.addEventListener("pagehide", cleanup, { once: true });
})();
