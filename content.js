(() => {
  const DEFAULT_PERCENT = 70;
  const DEFAULT_ENABLED = true;
  const TARGET_CLASS = "nico-vis-mask";
  const HIDE_PERCENT_VAR = "--nico-vis-hide-percent";
  const GUIDE_LINE_CLASS = "nico-vis-guide-line";
  const GUIDE_SHADE_CLASS = "nico-vis-guide-shade";
  const GUIDE_VISIBLE_MS = 650;
  const GUIDE_FADE_MS = 350;

  // Respond to ping from popup to confirm content script is active
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "ping") sendResponse({ active: true });
  });

  const SELECTORS = [
    "#CommentLayer",
    "#comment-layer",
    ".CommentLayer",
    ".commentLayer",
    ".comment-layer",
    ".VideoPlayer-CommentLayer",
    "[data-layer-name='comment']",
    "[data-name='comment']",
    "[class*='Comment'][class*='Layer']",
    "[class*='comment'][class*='layer']"
  ];

  let isEnabled = DEFAULT_ENABLED;
  let currentPercent = DEFAULT_PERCENT;
  let mutationObserver = null;
  let applyScheduled = false;
  let guideScheduled = false;
  const pendingRoots = new Set();
  const observedRoots = new WeakSet();
  let primaryTarget = null;
  let guideLineEl = null;
  let guideShadeEl = null;
  let guideHideTimer = null;
  let guideHideToken = 0;
  let guideVisibleUntil = 0;
  let initialized = false;

  function clampPercent(percent) {
    const value = Number(percent);
    if (!Number.isFinite(value)) return DEFAULT_PERCENT;
    return Math.min(100, Math.max(0, Math.round(value)));
  }

  function ensureGuideElements() {
    if (!guideLineEl) {
      guideLineEl = document.createElement("div");
      guideLineEl.className = GUIDE_LINE_CLASS;
      guideLineEl.style.position = "fixed";
      guideLineEl.style.height = "2px";
      guideLineEl.style.background = "rgba(90, 180, 255, 0.95)";
      guideLineEl.style.boxShadow = "0 0 0 1px rgba(20, 30, 60, 0.25), 0 0 12px rgba(90, 180, 255, 0.65)";
      guideLineEl.style.pointerEvents = "none";
      guideLineEl.style.zIndex = "2147483647";
      guideLineEl.style.opacity = "0";
      guideLineEl.style.transition = `top 90ms linear, width 90ms linear, opacity ${GUIDE_FADE_MS}ms ease`;
      guideLineEl.style.display = "none";
      document.body.appendChild(guideLineEl);
    }
    if (!guideShadeEl) {
      guideShadeEl = document.createElement("div");
      guideShadeEl.className = GUIDE_SHADE_CLASS;
      guideShadeEl.style.position = "fixed";
      guideShadeEl.style.background = "linear-gradient(to bottom, rgba(90, 180, 255, 0.12), rgba(20, 30, 60, 0.24))";
      guideShadeEl.style.pointerEvents = "none";
      guideShadeEl.style.zIndex = "2147483646";
      guideShadeEl.style.opacity = "0";
      guideShadeEl.style.transition = `top 90ms linear, height 90ms linear, width 90ms linear, opacity ${GUIDE_FADE_MS}ms ease`;
      guideShadeEl.style.display = "none";
      document.body.appendChild(guideShadeEl);
    }
  }

  function hideGuide(delayMs = 0, immediate = false) {
    clearTimeout(guideHideTimer);
    const token = ++guideHideToken;
    const complete = () => {
      if (token !== guideHideToken) return;
      if (guideLineEl) guideLineEl.style.display = "none";
      if (guideShadeEl) guideShadeEl.style.display = "none";
    };
    const startFade = () => {
      if (guideLineEl) guideLineEl.style.opacity = "0";
      if (guideShadeEl) guideShadeEl.style.opacity = "0";
      guideHideTimer = setTimeout(complete, GUIDE_FADE_MS);
    };
    if (immediate) {
      if (guideLineEl) guideLineEl.style.opacity = "0";
      if (guideShadeEl) guideShadeEl.style.opacity = "0";
      complete();
      return;
    }
    if (delayMs > 0) {
      guideHideTimer = setTimeout(startFade, delayMs);
      return;
    }
    startFade();
  }

  function setPrimaryTarget(elements) {
    if (!elements || elements.size === 0) return;
    let next = null;
    let bestArea = -1;
    for (const el of elements) {
      if (!(el instanceof Element) || !el.isConnected) continue;
      if (el.tagName === "CANVAS") continue;
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        next = el;
      }
    }
    if (next) primaryTarget = next;
  }

  function refreshPrimaryTarget() {
    let next = null;
    let bestArea = -1;
    const roots = getRoots();
    for (const root of roots) {
      for (const selector of SELECTORS) {
        if (root.nodeType === Node.ELEMENT_NODE && root.matches(selector)) {
          const rect = root.getBoundingClientRect();
          const area = rect.width * rect.height;
          if (area > bestArea) {
            bestArea = area;
            next = root;
          }
        }
        root.querySelectorAll(selector).forEach((el) => {
          if (!(el instanceof Element) || el.tagName === "CANVAS" || !el.isConnected) return;
          const rect = el.getBoundingClientRect();
          const area = rect.width * rect.height;
          if (area > bestArea) {
            bestArea = area;
            next = el;
          }
        });
      }
    }
    primaryTarget = next;
  }

  function pulseGuide() {
    guideVisibleUntil = Date.now() + GUIDE_VISIBLE_MS;
    scheduleGuideUpdate();
  }

  function updateGuide() {
    guideScheduled = false;
    ensureGuideElements();
    if (!isEnabled) {
      hideGuide(0, true);
      return;
    }
    if (!primaryTarget || !primaryTarget.isConnected) {
      refreshPrimaryTarget();
    }
    if (!primaryTarget || !primaryTarget.isConnected) {
      hideGuide(0, true);
      return;
    }
    const rect = primaryTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      hideGuide(0, true);
      return;
    }
    if (Date.now() > guideVisibleUntil) {
      hideGuide();
      return;
    }
    const hiddenRatio = currentPercent / 100;
    const boundaryTop = rect.top + rect.height * (1 - hiddenRatio);
    const shadeHeight = Math.max(0, rect.bottom - boundaryTop);

    guideLineEl.style.display = "block";
    guideLineEl.style.left = `${rect.left}px`;
    guideLineEl.style.top = `${Math.round(boundaryTop)}px`;
    guideLineEl.style.width = `${rect.width}px`;

    guideShadeEl.style.display = "block";
    guideShadeEl.style.left = `${rect.left}px`;
    guideShadeEl.style.top = `${Math.round(boundaryTop)}px`;
    guideShadeEl.style.width = `${rect.width}px`;
    guideShadeEl.style.height = `${Math.round(shadeHeight)}px`;
    guideLineEl.style.opacity = "1";
    guideShadeEl.style.opacity = shadeHeight > 0 ? "1" : "0";
    hideGuide(Math.max(0, guideVisibleUntil - Date.now()));
  }

  function scheduleGuideUpdate() {
    if (guideScheduled) return;
    guideScheduled = true;
    requestAnimationFrame(updateGuide);
  }

  function ensureRootPercent() {
    if (!document.documentElement.style.getPropertyValue(HIDE_PERCENT_VAR)) {
      document.documentElement.style.setProperty(HIDE_PERCENT_VAR, `${DEFAULT_PERCENT}%`);
    }
  }

  function applyMaskStyle(el) {
    if (!isEnabled) {
      removeMaskStyle(el);
      return;
    }
    if (el.classList.contains(TARGET_CLASS)) return;
    el.classList.add(TARGET_CLASS);
    el.style.setProperty(
      "-webkit-mask-image",
      `linear-gradient(to bottom, #000 calc(100% - var(${HIDE_PERCENT_VAR})), transparent calc(100% - var(${HIDE_PERCENT_VAR})))`
    );
    el.style.setProperty(
      "mask-image",
      `linear-gradient(to bottom, #000 calc(100% - var(${HIDE_PERCENT_VAR})), transparent calc(100% - var(${HIDE_PERCENT_VAR})))`
    );
    el.style.setProperty("-webkit-mask-size", "100% 100%");
    el.style.setProperty("mask-size", "100% 100%");
    el.style.setProperty("-webkit-mask-repeat", "no-repeat");
    el.style.setProperty("mask-repeat", "no-repeat");
  }

  function removeMaskStyle(el) {
    el.classList.remove(TARGET_CLASS);
    el.style.removeProperty("-webkit-mask-image");
    el.style.removeProperty("mask-image");
    el.style.removeProperty("-webkit-mask-size");
    el.style.removeProperty("mask-size");
    el.style.removeProperty("-webkit-mask-repeat");
    el.style.removeProperty("mask-repeat");
  }

  function applyMask(el) {
    applyMaskStyle(el);
    const canvases = el.querySelectorAll ? el.querySelectorAll("canvas") : [];
    canvases.forEach((canvas) => applyMaskStyle(canvas));
  }

  function removeMask(el) {
    removeMaskStyle(el);
    const canvases = el.querySelectorAll ? el.querySelectorAll("canvas") : [];
    canvases.forEach((canvas) => removeMaskStyle(canvas));
  }

  function getRoots() {
    const roots = [document];
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.shadowRoot) roots.push(node.shadowRoot);
    }
    return roots;
  }

  function applyToTargets(root = document) {
    const elements = new Set();
    for (const selector of SELECTORS) {
      if (root.nodeType === Node.ELEMENT_NODE && root.matches(selector)) {
        elements.add(root);
      }
      root.querySelectorAll(selector).forEach((el) => elements.add(el));
    }
    for (const el of elements) {
      if (isEnabled) {
        applyMask(el);
      } else {
        removeMask(el);
      }
    }
    setPrimaryTarget(elements);
    if (Date.now() <= guideVisibleUntil) {
      scheduleGuideUpdate();
    }
  }

  function flushApplyQueue() {
    applyScheduled = false;
    const roots = Array.from(pendingRoots);
    pendingRoots.clear();
    roots.forEach((root) => applyToTargets(root));
  }

  function scheduleApply(root) {
    pendingRoots.add(root);
    if (applyScheduled) return;
    applyScheduled = true;
    requestAnimationFrame(flushApplyQueue);
  }

  function observeShadowRootsInSubtree(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    const stack = [node];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current.shadowRoot) {
        observeRoot(current.shadowRoot);
        scheduleApply(current.shadowRoot);
      }
      for (const child of current.children) {
        stack.push(child);
      }
    }
  }

  function observeRoot(root) {
    if (!mutationObserver || observedRoots.has(root)) return;
    observedRoots.add(root);
    mutationObserver.observe(root, { childList: true, subtree: true });
  }

  function setPercent(percent, options = {}) {
    const value = clampPercent(percent);
    currentPercent = value;
    document.documentElement.style.setProperty(HIDE_PERCENT_VAR, `${value}%`);
    if (options.showGuide) pulseGuide();
  }

  function setEnabled(enabled, options = {}) {
    isEnabled = enabled;
    if (!isEnabled) {
      hideGuide(0, true);
    } else if (options.showGuide) {
      pulseGuide();
    }
    // Re-apply or remove masks on all targets
    getRoots().forEach((root) => applyToTargets(root));
  }

  function initFromStorage() {
    chrome.storage.sync.get(
      { hidePercent: DEFAULT_PERCENT, enabled: DEFAULT_ENABLED },
      (items) => {
        setPercent(items.hidePercent, { showGuide: false });
        setEnabled(items.enabled, { showGuide: false });
        initialized = true;
      }
    );
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if (changes.hidePercent) {
        setPercent(changes.hidePercent.newValue, { showGuide: initialized });
      }
      if (changes.enabled !== undefined) {
        setEnabled(changes.enabled.newValue, { showGuide: initialized });
      }
    });
  }

  function observe() {
    mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type !== "childList" || mutation.addedNodes.length === 0) continue;
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          scheduleApply(node);
          observeShadowRootsInSubtree(node);
        });
      }
    });
    getRoots().forEach((root) => observeRoot(root));
    window.addEventListener("resize", () => {
      if (Date.now() <= guideVisibleUntil) scheduleGuideUpdate();
    });
    window.addEventListener("scroll", () => {
      if (Date.now() <= guideVisibleUntil) scheduleGuideUpdate();
    }, { passive: true });
  }

  function start() {
    ensureRootPercent();
    initFromStorage();
    getRoots().forEach((root) => applyToTargets(root));
    observe();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
