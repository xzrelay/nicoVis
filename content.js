(() => {
  const DEFAULT_PERCENT = 70;
  const DEFAULT_ENABLED = true;
  const TARGET_CLASS = "nico-vis-mask";
  const HIDE_PERCENT_VAR = "--nico-vis-hide-percent";

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
  let mutationObserver = null;
  let applyScheduled = false;
  const pendingRoots = new Set();
  const observedRoots = new WeakSet();

  function clampPercent(percent) {
    const value = Number(percent);
    if (!Number.isFinite(value)) return DEFAULT_PERCENT;
    return Math.min(100, Math.max(0, Math.round(value)));
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

  function setPercent(percent) {
    const value = clampPercent(percent);
    document.documentElement.style.setProperty(HIDE_PERCENT_VAR, `${value}%`);
  }

  function setEnabled(enabled) {
    isEnabled = enabled;
    // Re-apply or remove masks on all targets
    getRoots().forEach((root) => applyToTargets(root));
  }

  function initFromStorage() {
    chrome.storage.sync.get(
      { hidePercent: DEFAULT_PERCENT, enabled: DEFAULT_ENABLED },
      (items) => {
        setPercent(items.hidePercent);
        setEnabled(items.enabled);
      }
    );
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if (changes.hidePercent) {
        setPercent(changes.hidePercent.newValue);
      }
      if (changes.enabled !== undefined) {
        setEnabled(changes.enabled.newValue);
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
